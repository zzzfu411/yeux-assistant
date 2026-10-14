import type { Row, Store } from '../../storage/src/index.js';
import { ModelRuleProposal } from '../../contracts/src/workspace.js';
import { AppError, checkVersion, digest, notify, requireRow } from './common.js';
import { directModelJSON } from './model.js';
import type { Rules } from './workspace/rules.js';

const INSTRUCTION =
  'RULE_PROPOSAL\n比较“助手原稿”和“本人终稿”，总结一条以后同类任务都应遵守、具体可执行的规则，例如称呼、语气、格式、必须核对的事实或常犯的错误。' +
  'scope 从 mail、errand、work、correction、preference 中选择最贴切的一个；key 用小写英文、数字和短横线描述规则。' +
  '只总结有普遍性的纠正；如果修改只是这一次的内容补充，content 写“无通用规则”。rationale 说明依据的是哪处修改。';

/** How much of the text actually changed, ignoring a shared prefix and suffix. */
export function changedLength(before: string, after: string) {
  const a = before.replace(/\s+/g, ' ').trim(),
    b = after.replace(/\s+/g, ' ').trim();
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - start - end;
}

type Proposal = { key: string; scope: string; content: string; rationale: string };
/** One proposal per draft at a time; a retry while the model is still writing joins that call. */
const inFlight = new Map<string, { work: Promise<Proposal>; detached: boolean }>();
/** The API closes idle sockets after 20 s; a real model needs 30–60 s for this call. */
export const PROPOSAL_WAIT_MS = 15000;

async function answerOrPending(entry: { work: Promise<Proposal>; detached: boolean }, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), waitMs);
  });
  try {
    const result = await Promise.race([entry.work, late]);
    if (result !== 'pending') return result;
    entry.detached = true;
    return { pending: true as const };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One explicit model call that turns the owner's edit into a proposed rule. The proposal stays
 * unconfirmed (database only) until the owner edits and confirms it; only then it is written to Git.
 * Input problems are answered at once. If the model is still writing after `waitMs`, the request
 * answers `{ pending: true }` and the result arrives as a notification instead of a broken request.
 */
export async function proposeRule(
  store: Store,
  folder: string,
  rules: Rules,
  key: string,
  sessionId: string,
  revision: number,
  waitMs = PROPOSAL_WAIT_MS,
) {
  const replay = await store.one('SELECT response FROM app.commands WHERE key=$1', [key]);
  if (replay) return replay.response;
  const running = inFlight.get(sessionId);
  if (running) return answerOrPending(running, waitMs);
  const material = await store.snapshot(async (tx) => {
    const session = await requireRow(tx, 'SELECT * FROM app.sessions WHERE id=$1', [sessionId]);
    checkVersion(session, revision);
    const edited = await tx.one(
      "SELECT content,created_at FROM app.artifacts WHERE session_id=$1 AND provenance='user_revision' AND kind='draft' ORDER BY created_at DESC,id DESC LIMIT 1",
      [sessionId],
    );
    if (!edited) throw new AppError('请先修改草稿并保存一次，再从修改中总结规则。', 409, 'no_edit');
    const original = await tx.one(
      "SELECT content FROM app.artifacts WHERE session_id=$1 AND provenance='model_generated' AND created_at<=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [sessionId, edited.created_at],
    );
    if (!original) throw new AppError('没有找到助手的原稿，无法比较修改。', 409, 'no_original');
    if (changedLength(original.content, edited.content) < 20)
      throw new AppError('这次修改很少，暂时总结不出规则。', 409, 'edit_too_small');
    const confirmed = await tx.rows('SELECT key,content FROM app.memories WHERE enabled AND confirmed ORDER BY key');
    return { session, original: original.content as string, edited: edited.content as string, confirmed };
  });
  const entry = { work: draftProposal(store, folder, rules, key, material), detached: false };
  inFlight.set(sessionId, entry);
  entry.work.then(
    async (proposal) => {
      inFlight.delete(sessionId);
      if (entry.detached)
        await store.transaction((tx) =>
          notify(tx, 'rule-proposal:' + key, sessionId, '规则提议已生成，等你确认', proposal.content.slice(0, 120)),
        );
    },
    async (error) => {
      inFlight.delete(sessionId);
      if (entry.detached)
        await store.transaction((tx) =>
          notify(
            tx,
            'rule-proposal:' + key,
            sessionId,
            '没能从修改中总结出规则',
            error instanceof AppError ? error.message : '模型暂时不可用，可稍后重试。',
          ),
        );
    },
  );
  return answerOrPending(entry, waitMs);
}

async function draftProposal(
  store: Store,
  folder: string,
  rules: Rules,
  key: string,
  material: { session: Row; original: string; edited: string; confirmed: Row[] },
): Promise<Proposal> {
  const proposal = await directModelJSON(folder, ModelRuleProposal, INSTRUCTION, {
    task: '从本人的修改中总结规则：' + material.session.title,
    latest: '助手原稿：\n' + material.original.slice(0, 6000) + '\n\n本人终稿：\n' + material.edited.slice(0, 6000),
    previous: '',
    rules: material.confirmed.map((m) => m.key + ': ' + m.content),
    notes: [],
    sources: [],
  });
  if (/无通用规则/.test(proposal.content))
    throw new AppError('这次修改看起来只是一次性的补充，没有总结出通用规则。', 409, 'no_general_rule');
  let ruleKey = proposal.key
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (ruleKey.length < 3) ruleKey = 'rule-' + digest(proposal.content).slice(0, 8);
  for (let n = 2; await store.one('SELECT key FROM app.memories WHERE key=$1', [ruleKey]); n++)
    ruleKey = ruleKey.replace(/-\d+$/, '') + '-' + n;
  await rules.save(key, {
    key: ruleKey,
    scope: proposal.scope,
    content: proposal.content,
    confirmed: false,
    enabled: true,
    revision: 0,
  });
  return { key: ruleKey, scope: proposal.scope, content: proposal.content, rationale: proposal.rationale };
}
