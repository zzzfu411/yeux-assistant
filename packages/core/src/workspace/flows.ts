import type { Store, Tx } from '../../../storage/src/index.js';
import { FlowDefinition, SaveFlowInput } from '../../../contracts/src/workspace.js';
import { AppError, digest, event, notify, once } from '../common.js';
import { WorkspaceRepo, WORKSPACE_LOCK } from './repo.js';
import { files, formatFile, parseFile } from './files.js';

/** A flow chooses registered steps; confirmation, budgets and adapters are owned by code. */
export class Flows {
  readonly repo: WorkspaceRepo;
  constructor(
    readonly store: Store,
    folder: string,
  ) {
    this.repo = new WorkspaceRepo(folder);
  }
  list() {
    return this.store.rows('SELECT * FROM app.flows ORDER BY id');
  }
  async scan() {
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      return this.scanLocked(tx);
    });
  }
  async scanLocked(tx: Tx) {
    const names = await files(this.repo, 'flows'),
      seen = new Set(names),
      parsed: Array<{
        path: string;
        text: string;
        value: ReturnType<typeof parseFile<ReturnType<typeof FlowDefinition.parse>>>;
      }> = [];
    for (const path of names) {
      try {
        const text = await this.repo.read(path);
        parsed.push({ path, text, value: parseFile(text, FlowDefinition) });
      } catch {
        await tx.exec('UPDATE app.flows SET enabled=false WHERE path=$1', [path]);
        await notify(
          tx,
          'flow-invalid:' + digest(path),
          null,
          '流程文件无效，已停用',
          path + '；请检查步骤、确认规则与配置版本。',
        );
      }
    }
    const ids = parsed.map((entry) => entry.value.header.id);
    for (const { path, text, value } of parsed) {
      if (ids.filter((id) => id === value.header.id).length > 1) {
        await tx.exec('UPDATE app.flows SET enabled=false WHERE id=$1', [value.header.id]);
        await notify(tx, 'flow-conflict:' + digest(value.header.id), null, '流程标识重复，已停用', value.header.id);
        continue;
      }
      const old = await tx.one('SELECT * FROM app.flows WHERE id=$1', [value.header.id]);
      if (old?.digest === digest(text) && old.path === path && old.enabled === value.header.enabled) continue;
      if (old && value.header.version <= old.version && old.digest !== digest(text)) {
        await tx.exec('UPDATE app.flows SET enabled=false WHERE id=$1', [old.id]);
        await notify(tx, 'flow-version:' + digest(text), null, '流程版本需要提升', path);
        continue;
      }
      const latest = (await this.repo.log(path, 1))[0] || null;
      const commit = latest && (await this.repo.show(latest, path).catch(() => null)) === text ? latest : null;
      await tx.exec(
        `INSERT INTO app.flows(id,path,version,digest,commit_sha,enabled,definition) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET path=excluded.path,version=excluded.version,digest=excluded.digest,commit_sha=excluded.commit_sha,enabled=excluded.enabled,definition=excluded.definition,updated_at=now()`,
        [
          value.header.id,
          path,
          value.header.version,
          digest(text),
          commit,
          value.header.enabled,
          JSON.stringify({ ...value.header, instructions: value.content }),
        ],
      );
      await event(tx, 'flow.updated', value.header.id);
    }
    for (const old of await tx.rows('SELECT * FROM app.flows WHERE enabled'))
      if (!seen.has(old.path)) {
        await tx.exec('UPDATE app.flows SET enabled=false WHERE id=$1', [old.id]);
        await event(tx, 'flow.updated', old.id);
      }
    return { files: names.length };
  }
  async save(key: string, input: unknown) {
    const data = SaveFlowInput.parse(input),
      path = 'flows/' + data.definition.id + '.md';
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      return once(tx, key, 'flow.save', data, async () => {
        const replay = await this.repo.findCommitByTrailer(digest(key));
        if (replay) {
          if (replay.fields['Yeux-Input'] !== digest(data))
            throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict');
          await this.scanLocked(tx);
          return { id: data.definition.id, version: data.definition.version, commitSha: replay.hash };
        }
        const old = await tx.one('SELECT * FROM app.flows WHERE id=$1', [data.definition.id]);
        if ((old?.version || 0) !== data.revision || data.definition.version !== data.revision + 1)
          throw new AppError('流程版本已变化，请载入最新版本。', 409, 'version_conflict');
        const status = await this.repo.status();
        if (
          status.locked ||
          status.changes.some((change) => change.path === path || (change.status[0] !== ' ' && change.status !== '??'))
        )
          throw new AppError('请先处理工作区中的手工修改或 Git 锁。', 409, 'workspace_changed');
        const text = formatFile(data.definition, data.instructions);
        await this.repo.write(path, text);
        const commit = await this.repo.commitFiles([path], `flow: ${data.definition.id} v${data.definition.version}`, {
          'Yeux-Command': digest(key),
          'Yeux-Input': digest(data),
          'Yeux-Path': path,
        });
        await this.scanLocked(tx);
        return { id: data.definition.id, version: data.definition.version, commitSha: commit };
      });
    });
  }
}
