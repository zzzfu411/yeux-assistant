import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../../storage/src/index.js';
import { AppError } from './common.js';

const Credential = z
  .object({
    username: z.string().min(1).max(80),
    salt: z.string().regex(/^[a-f0-9]{32}$/),
    hash: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
export const SESSION_COOKIE = 'yeux_session';
export const SESSION_SECONDS = 8 * 60 * 60;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function passwordHash(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
export async function setAdministrator(folder: string, username: string, password: string) {
  if (!username.trim() || username.length > 80 || password.length < 8 || password.length > 1024)
    throw new AppError('账号不能为空，密码需要 8–1024 个字符。');
  const salt = randomBytes(16).toString('hex'),
    value = { username: username.trim(), salt, hash: (await passwordHash(password, salt)).toString('hex') };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, '.admin-' + randomBytes(8).toString('hex'));
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, join(folder, 'admin-auth.json'));
}
export function sessionCookie(raw: string | undefined) {
  const value = raw
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE + '='))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
export function cookieHeader(value: string, secure: boolean, clear = false) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}
export class Authentication {
  constructor(
    readonly store: Store,
    readonly folder: string,
  ) {}
  private async credential() {
    try {
      return Credential.parse(JSON.parse(await readFile(join(this.folder, 'admin-auth.json'), 'utf8')));
    } catch (error: any) {
      if (error.code === 'ENOENT') return null;
      throw new AppError('管理员配置无法读取，请在电脑上重新设置账号。', 503, 'auth_config_invalid');
    }
  }
  async login(username: string, password: string) {
    const credential = await this.credential();
    if (!credential)
      throw new AppError('尚未设置管理员，请在电脑上运行 pnpm admin:setup。', 503, 'admin_not_configured');
    // A single-user instance has a shared attempt budget, independent of supplied username/IP.
    const budget = await this.store.one(`INSERT INTO app.auth_limits(key,started_at,attempts) VALUES('login',now(),1)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN app.auth_limits.started_at<now()-interval '1 minute' THEN 1 ELSE app.auth_limits.attempts+1 END,
      started_at=CASE WHEN app.auth_limits.started_at<now()-interval '1 minute' THEN now() ELSE app.auth_limits.started_at END RETURNING attempts`);
    if (Number(budget!.attempts) > 8) throw new AppError('尝试次数过多，请一分钟后再登录。', 429, 'login_limited');
    const candidate = await passwordHash(password, credential.salt);
    if (!timingSafeEqual(candidate, Buffer.from(credential.hash, 'hex')) || username !== credential.username)
      throw new AppError('账号或密码不正确。', 401, 'invalid_credentials');
    const current = await this.credential();
    if (JSON.stringify(current) !== JSON.stringify(credential))
      throw new AppError('账号刚被更新，请重新登录。', 401, 'credentials_changed');
    const token = randomBytes(32).toString('hex'),
      revision = hash(JSON.stringify(credential));
    await this.store.transaction(async (tx) => {
      await tx.exec('DELETE FROM app.auth_sessions WHERE expires_at<=now() OR credential_revision<>$1', [revision]);
      await tx.exec(
        "INSERT INTO app.auth_sessions(token_hash,credential_revision,expires_at) VALUES($1,$2,now()+interval '8 hours')",
        [hash(token), revision],
      );
    });
    return { token, username: credential.username };
  }
  async username(token: string | undefined) {
    if (!token) return null;
    const credential = await this.credential();
    if (!credential) return null;
    const row = await this.store.one(
      'SELECT token_hash FROM app.auth_sessions WHERE token_hash=$1 AND credential_revision=$2 AND expires_at>now()',
      [hash(token), hash(JSON.stringify(credential))],
    );
    return row ? credential.username : null;
  }
  async logout(token: string | undefined) {
    if (token) await this.store.exec('DELETE FROM app.auth_sessions WHERE token_hash=$1', [hash(token)]);
  }
}
