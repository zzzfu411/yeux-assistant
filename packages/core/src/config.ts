import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { AppError, canonical, id } from './common.js';
import { ModelSettingsInput } from '../../contracts/src/index.js';
import { z } from 'zod';

// This private ledger is committed in the same rename as the configuration.
// It lets the API recover a file write whose PostgreSQL command commit failed.
const RECEIPTS='_assistant_config_commands';
const PublicSettings=z.object({base_url:z.string(),model:z.string(),has_api_key:z.boolean(),tools:z.boolean(),revision:z.string().regex(/^[a-f0-9]{64}$/),mail_configured:z.boolean()}).strict();
export type ModelSettingsSnapshot=z.infer<typeof PublicSettings>;
const ReceiptLedger=z.object({version:z.literal(1),records:z.record(z.string().regex(/^[a-f0-9]{64}$/),z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),response:PublicSettings}).strict())}).strict();
type ReceiptLedger=z.infer<typeof ReceiptLedger>;

function parseConfig(raw:string):Record<string,any> {
  try {const value=raw?JSON.parse(raw):{};if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch {throw new AppError('配置文件无法读取，请检查 private/config.json。');}
}

export const dataFolder = () => resolve(process.env.ASSISTANT_DATA || 'private');
export async function initializeData(folder = dataFolder()) {
  for (const sub of ['', 'documents', 'artifacts', 'backups', 'receipts', 'mail-quarantine']) await mkdir(join(folder, sub), { recursive: true, mode: 0o700 });
  try { await writeFile(join(folder, 'access-token'), randomBytes(32).toString('base64url'), { flag:'wx', mode:0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  const token=(await readFile(join(folder, 'access-token'), 'utf8')).trim();
  if(!token)throw new AppError('访问口令为空，请修复 private/access-token 后再启动。');
  return token;
}
export async function config(folder = dataFolder()): Promise<Record<string, any>> {
  try { return parseConfig(await readFile(join(folder, 'config.json'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw new AppError('配置文件无法读取，请检查 private/config.json。'); }
}
export function validateBaseURL(value: string) {
  if (!value) return '';
  let url: URL; try { url = new URL(value); } catch { throw new AppError('模型地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError('模型地址只接受不含账号、查询参数和片段的 HTTP(S) 地址。');
  return value.replace(/\/+$/, '');
}
export class Settings {
  constructor(readonly folder: string, readonly token: string) {}
  async raw() { try { return await readFile(join(this.folder, 'config.json'), 'utf8'); } catch (e: any) { if (e.code==='ENOENT') return ''; throw e; } }
  private fingerprint(value:unknown) {return createHmac('sha256',this.token).update(canonical(value)).digest('hex');}
  private businessRevision(value:Record<string,any>) {
    const {[RECEIPTS]:_receipts,...business}=value;
    return this.fingerprint(business);
  }
  revision(raw: string) {return this.businessRevision(parseConfig(raw));}
  private snapshot(value:Record<string,any>):ModelSettingsSnapshot {
    const llm=value.llm||{};
    let base='';try{base=validateBaseURL(typeof llm.base_url==='string'?llm.base_url:'');}catch{/* Never echo a credential-bearing legacy URL. */}
    return {base_url:base,model:typeof llm.model==='string'?llm.model:'',has_api_key:Boolean(llm.api_key),tools:llm.tools!==false,revision:this.businessRevision(value),mail_configured:Boolean(value.mail_user&&value.mail_password)};
  }
  private ledger(value:Record<string,any>):ReceiptLedger {
    if(value[RECEIPTS]===undefined)return {version:1,records:{}};
    const parsed=ReceiptLedger.safeParse(value[RECEIPTS]);
    if(!parsed.success)throw new AppError('配置保存回执格式无效；请保留配置文件并检查本地备份，不能覆盖原回执。');
    return parsed.data;
  }
  async get() {
    return this.snapshot(parseConfig(await this.raw()));
  }
  async save(input: unknown, commandKey?:string):Promise<ModelSettingsSnapshot> {
    const data = ModelSettingsInput.parse(input), raw = await this.raw();
    const value=parseConfig(raw),ledger=this.ledger(value);
    if(commandKey!==undefined && (!commandKey||commandKey.length>160))throw new AppError('需要有效的 Idempotency-Key。');
    const receiptKey=commandKey===undefined?undefined:this.fingerprint({commandKey}),requestDigest=this.fingerprint(data);
    const previous=receiptKey?ledger.records[receiptKey]:undefined;
    if(previous) {
      if(previous.digest!==requestDigest)throw new AppError('同一请求标识不能用于不同内容。',409,'idempotency_conflict');
      // Return the original no-secret acknowledgement without changing a newer config.
      return previous.response;
    }
    if (data.revision !== this.businessRevision(value)) throw new AppError('配置已更新，请重新载入；当前输入会保留。',409,'version_conflict');
    const base = validateBaseURL(data.base_url);
    if (base && !data.model.trim()) throw new AppError('请填写模型名称。');
    if (/[\x00-\x1f\x7f]/.test(data.api_key)) throw new AppError('密钥包含无效控制字符。');
    if(value.llm!==undefined && value.llm!==null && (typeof value.llm!=='object'||Array.isArray(value.llm)))throw new AppError('现有 llm 配置不是对象，请先检查配置文件。');
    value.llm = { ...value.llm, base_url:base, model:data.model.trim(), tools:data.tools, ...(data.api_key ? {api_key:data.api_key} : {}) };
    const response=this.snapshot(value);
    if(receiptKey) {ledger.records[receiptKey]={digest:requestDigest,response};value[RECEIPTS]=ledger;}
    const temporary = join(this.folder, '.config-' + id());
    try {
      await writeFile(temporary, JSON.stringify(value,null,2)+'\n', { mode:0o600, flag:'wx', flush:true });
      if (await this.raw() !== raw) throw new AppError('配置文件刚被修改，请重新载入。',409,'version_conflict');
      await rename(temporary, join(this.folder,'config.json'));
    } finally { await unlink(temporary).catch(() => {}); }
    return response;
  }
}
