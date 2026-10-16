import { WorkspaceRepo } from './workspace/repo.js';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { AppError, canonical, id } from './common.js';
import { ModelSettingsInput } from '../../contracts/src/index.js';
import { MailSettingsInput, type MailSettingsView } from '../../contracts/src/mail.js';
import { z } from 'zod';

// This private ledger is committed in the same rename as the configuration.
// It lets the API recover a file write whose PostgreSQL command commit failed.
const RECEIPTS = '_assistant_config_commands';
const MAIL_RECEIPTS = '_assistant_mail_commands';
// The mailbox is a separate settings section with its own revision, so saving one form never
// makes the other stale. The file-level raw check still serialises concurrent writers.
const MAIL_KEYS = [
  'mail_mode',
  'mail_user',
  'mail_password',
  'imap_host',
  'imap_port',
  'smtp_host',
  'smtp_port',
  'poll_mail',
  'mail_auto_draft',
  'mail_daily_limit',
] as const;
const PublicMail = z
  .object({
    mode: z.enum(['off', 'imap', 'simulation']),
    address: z.string(),
    has_password: z.boolean(),
    imap_host: z.string(),
    imap_port: z.number(),
    smtp_host: z.string(),
    smtp_port: z.number(),
    poll: z.boolean(),
    auto_draft: z.enum(['none', 'direct', 'all']),
    daily_limit: z.number(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const MailLedger = z
  .object({
    version: z.literal(1),
    records: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), response: PublicMail }).strict(),
    ),
  })
  .strict();
/** Older configs had only an account and password; they keep working as IMAP. */
export function mailMode(settings: Record<string, any>): 'off' | 'imap' | 'simulation' {
  if (['simulation', 'imap', 'off'].includes(settings.mail_mode)) return settings.mail_mode;
  return settings.mail_user && settings.mail_password ? 'imap' : 'off';
}
const hostname = (value: string) => {
  if (value && !/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value))
    throw new AppError('邮件服务器地址只接受主机名，例如 imap.example.com。');
  return value.toLowerCase();
};
const PublicSettings = z
  .object({
    base_url: z.string(),
    model: z.string(),
    has_api_key: z.boolean(),
    tools: z.boolean(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    mail_configured: z.boolean(),
    // Optional so acknowledgements stored before the reviewer existed still parse.
    review_base_url: z.string().optional(),
    review_model: z.string().optional(),
    has_review_api_key: z.boolean().optional(),
    fast_model: z.string().optional(),
  })
  .strict();
export type ModelSettingsSnapshot = z.infer<typeof PublicSettings>;
const ReceiptLedger = z
  .object({
    version: z.literal(1),
    records: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), response: PublicSettings }).strict(),
    ),
  })
  .strict();
type ReceiptLedger = z.infer<typeof ReceiptLedger>;

function parseConfig(raw: string): Record<string, any> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AppError('配置文件无法读取，请检查 private/config.json。');
  }
}

export const dataFolder = () => resolve(process.env.ASSISTANT_DATA || 'private');
export async function initializeData(folder = dataFolder()) {
  for (const sub of ['', 'documents', 'artifacts', 'backups', 'receipts', 'mail-quarantine'])
    await mkdir(join(folder, sub), { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(folder, 'access-token'), randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  const token = (await readFile(join(folder, 'access-token'), 'utf8')).trim();
  if (!token) throw new AppError('访问口令为空，请修复 private/access-token 后再启动。');
  await new WorkspaceRepo(folder).initialize();
  return token;
}
export async function config(folder = dataFolder()): Promise<Record<string, any>> {
  try {
    return parseConfig(await readFile(join(folder, 'config.json'), 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw new AppError('配置文件无法读取，请检查 private/config.json。');
  }
}
export function validateBaseURL(value: string) {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('模型地址无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new AppError('模型地址只接受不含账号、查询参数和片段的 HTTP(S) 地址。');
  return value.replace(/\/+$/, '');
}
/** Steps the settings page's single "fast model" field applies to (same service and key). */
export const FAST_PROFILES = ['extract', 'draft'] as const;
/**
 * Resolve the endpoint for a model role. The reviewer falls back to the main model, and only
 * reuses the main key when it targets the same service, so a key never leaves its provider.
 */
export function modelFor(
  llm: Record<string, any> | undefined,
  role: 'solve' | 'review' = 'solve',
): Record<string, any> & { independent: boolean } {
  const review = llm?.review;
  if (role === 'review' && review && typeof review === 'object' && review.base_url && review.model)
    return {
      ...llm,
      base_url: review.base_url as string,
      model: review.model as string,
      api_key: (review.api_key as string | undefined) ?? (review.base_url === llm!.base_url ? llm!.api_key : undefined),
      independent: true,
    };
  return { ...llm, independent: false };
}
export class Settings {
  constructor(
    readonly folder: string,
    readonly token: string,
  ) {}
  async raw() {
    try {
      return await readFile(join(this.folder, 'config.json'), 'utf8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return '';
      throw e;
    }
  }
  private fingerprint(value: unknown) {
    return createHmac('sha256', this.token).update(canonical(value)).digest('hex');
  }
  private businessRevision(value: Record<string, any>) {
    const { [RECEIPTS]: _receipts, [MAIL_RECEIPTS]: _mailReceipts, ...business } = value;
    for (const key of MAIL_KEYS) delete business[key];
    return this.fingerprint(business);
  }
  private mailRevision(value: Record<string, any>) {
    return this.fingerprint(Object.fromEntries(MAIL_KEYS.map((key) => [key, value[key] ?? null])));
  }
  private mailSnapshot(value: Record<string, any>): MailSettingsView {
    return {
      mode: mailMode(value),
      address: typeof value.mail_user === 'string' ? value.mail_user : '',
      has_password: Boolean(value.mail_password),
      imap_host: typeof value.imap_host === 'string' ? value.imap_host : '',
      imap_port: Number(value.imap_port) || 993,
      smtp_host: typeof value.smtp_host === 'string' ? value.smtp_host : '',
      smtp_port: Number(value.smtp_port) || 465,
      poll: value.poll_mail === true,
      auto_draft: ['none', 'direct', 'all'].includes(value.mail_auto_draft) ? value.mail_auto_draft : 'direct',
      daily_limit: Number.isInteger(value.mail_daily_limit) ? value.mail_daily_limit : 10,
      revision: this.mailRevision(value),
    };
  }
  async getMail() {
    return this.mailSnapshot(parseConfig(await this.raw()));
  }
  async saveMail(input: unknown, commandKey?: string): Promise<MailSettingsView> {
    const data = MailSettingsInput.parse(input),
      raw = await this.raw();
    const value = parseConfig(raw);
    let ledger: z.infer<typeof MailLedger> = { version: 1, records: {} };
    if (value[MAIL_RECEIPTS] !== undefined) {
      const parsed = MailLedger.safeParse(value[MAIL_RECEIPTS]);
      if (!parsed.success) throw new AppError('邮箱配置回执格式无效；请检查本地备份，不能覆盖原回执。');
      ledger = parsed.data;
    }
    if (commandKey !== undefined && (!commandKey || commandKey.length > 160))
      throw new AppError('需要有效的 Idempotency-Key。');
    const receiptKey = commandKey === undefined ? undefined : this.fingerprint({ mail: commandKey }),
      requestDigest = this.fingerprint(data);
    const previous = receiptKey ? ledger.records[receiptKey] : undefined;
    if (previous) {
      if (previous.digest !== requestDigest)
        throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict');
      return previous.response;
    }
    if (data.revision !== this.mailRevision(value))
      throw new AppError('邮箱配置已更新，请重新载入；当前输入会保留。', 409, 'version_conflict');
    if (/[\x00-\x1f\x7f]/.test(data.password)) throw new AppError('邮箱密码包含无效控制字符。');
    if (data.mode === 'imap' && !data.password && !value.mail_password)
      throw new AppError('真实邮箱需要客户端专用密码或授权码。');
    value.mail_mode = data.mode;
    value.mail_user = data.mode === 'off' && !data.address ? value.mail_user || '' : data.address;
    if (data.password) value.mail_password = data.password;
    value.imap_host = hostname(data.imap_host);
    value.imap_port = data.imap_port;
    value.smtp_host = hostname(data.smtp_host);
    value.smtp_port = data.smtp_port;
    value.poll_mail = data.mode !== 'off' && data.poll;
    value.mail_auto_draft = data.auto_draft;
    value.mail_daily_limit = data.daily_limit;
    const response = this.mailSnapshot(value);
    if (receiptKey) {
      ledger.records[receiptKey] = { digest: requestDigest, response };
      value[MAIL_RECEIPTS] = ledger;
    }
    await this.write(value, raw);
    return response;
  }
  private async write(value: Record<string, any>, raw: string) {
    const temporary = join(this.folder, '.config-' + id());
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      if ((await this.raw()) !== raw) throw new AppError('配置文件刚被修改，请重新载入。', 409, 'version_conflict');
      await rename(temporary, join(this.folder, 'config.json'));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  revision(raw: string) {
    return this.businessRevision(parseConfig(raw));
  }
  private snapshot(value: Record<string, any>): ModelSettingsSnapshot {
    const llm = value.llm || {};
    let base = '';
    try {
      base = validateBaseURL(typeof llm.base_url === 'string' ? llm.base_url : '');
    } catch {
      /* Never echo a credential-bearing legacy URL. */
    }
    return {
      base_url: base,
      model: typeof llm.model === 'string' ? llm.model : '',
      has_api_key: Boolean(llm.api_key),
      tools: llm.tools !== false,
      revision: this.businessRevision(value),
      mail_configured: mailMode(value) !== 'off',
      review_base_url: typeof llm.review?.base_url === 'string' ? llm.review.base_url : '',
      review_model: typeof llm.review?.model === 'string' ? llm.review.model : '',
      has_review_api_key: Boolean(llm.review?.api_key),
      fast_model: typeof llm.profiles?.extract?.model === 'string' ? llm.profiles.extract.model : '',
    };
  }
  private ledger(value: Record<string, any>): ReceiptLedger {
    if (value[RECEIPTS] === undefined) return { version: 1, records: {} };
    const parsed = ReceiptLedger.safeParse(value[RECEIPTS]);
    if (!parsed.success) throw new AppError('配置保存回执格式无效；请保留配置文件并检查本地备份，不能覆盖原回执。');
    return parsed.data;
  }
  async get() {
    return this.snapshot(parseConfig(await this.raw()));
  }
  async save(input: unknown, commandKey?: string): Promise<ModelSettingsSnapshot> {
    const data = ModelSettingsInput.parse(input),
      raw = await this.raw();
    const value = parseConfig(raw),
      ledger = this.ledger(value);
    if (commandKey !== undefined && (!commandKey || commandKey.length > 160))
      throw new AppError('需要有效的 Idempotency-Key。');
    const receiptKey = commandKey === undefined ? undefined : this.fingerprint({ commandKey }),
      requestDigest = this.fingerprint(data);
    const previous = receiptKey ? ledger.records[receiptKey] : undefined;
    if (previous) {
      if (previous.digest !== requestDigest)
        throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict');
      // Return the original no-secret acknowledgement without changing a newer config.
      return previous.response;
    }
    if (data.revision !== this.businessRevision(value))
      throw new AppError('配置已更新，请重新载入；当前输入会保留。', 409, 'version_conflict');
    const base = validateBaseURL(data.base_url);
    if (base && !data.model.trim()) throw new AppError('请填写模型名称。');
    if (/[\x00-\x1f\x7f]/.test(data.api_key)) throw new AppError('密钥包含无效控制字符。');
    if (value.llm !== undefined && value.llm !== null && (typeof value.llm !== 'object' || Array.isArray(value.llm)))
      throw new AppError('现有 llm 配置不是对象，请先检查配置文件。');
    const priorReview: Record<string, any> | undefined =
      value.llm?.review && typeof value.llm.review === 'object' ? value.llm.review : undefined;
    let review = priorReview;
    if (data.review_api_key && /[\x00-\x1f\x7f]/.test(data.review_api_key))
      throw new AppError('评阅密钥包含无效控制字符。');
    if (data.review_base_url !== undefined || data.review_model !== undefined) {
      const reviewBase = validateBaseURL((data.review_base_url ?? priorReview?.base_url ?? '').trim()),
        reviewModel = (data.review_model ?? priorReview?.model ?? '').trim();
      if (!reviewBase && !reviewModel) review = undefined;
      else if (!reviewBase || !reviewModel)
        throw new AppError('评阅模型需要同时填写地址和名称；两项都留空则使用主模型评阅。');
      else
        review = {
          base_url: reviewBase,
          model: reviewModel,
          // A saved reviewer key stays only with the same service address.
          ...(data.review_api_key
            ? { api_key: data.review_api_key }
            : priorReview?.api_key && priorReview.base_url === reviewBase
              ? { api_key: priorReview.api_key }
              : {}),
        };
    } else if (data.review_api_key && priorReview) review = { ...priorReview, api_key: data.review_api_key };
    const { review: _previousReview, profiles: priorProfiles, ...llm } = value.llm || {};
    let profiles: Record<string, Record<string, unknown>> = priorProfiles &&
    typeof priorProfiles === 'object' &&
    !Array.isArray(priorProfiles)
      ? { ...priorProfiles }
      : {};
    if (data.fast_model !== undefined) {
      const fast = data.fast_model.trim();
      for (const name of FAST_PROFILES) {
        const { model: _model, ...rest } = profiles[name] && typeof profiles[name] === 'object' ? profiles[name] : {};
        profiles[name] = fast ? { ...rest, model: fast } : rest;
        if (!Object.keys(profiles[name]).length) delete profiles[name];
      }
    }
    value.llm = {
      ...llm,
      base_url: base,
      model: data.model.trim(),
      tools: data.tools,
      ...(data.api_key ? { api_key: data.api_key } : {}),
      ...(review ? { review } : {}),
      ...(Object.keys(profiles).length ? { profiles } : {}),
    };
    const response = this.snapshot(value);
    if (receiptKey) {
      ledger.records[receiptKey] = { digest: requestDigest, response };
      value[RECEIPTS] = ledger;
    }
    await this.write(value, raw);
    return response;
  }
}
