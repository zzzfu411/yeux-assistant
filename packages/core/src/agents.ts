import { ZodError } from 'zod';
import { randomBytes } from 'node:crypto';
import type { Store, Tx, Row } from '../../storage/src/index.js';
import {
  CreateAgent,
  AgentCredential,
  AgentRequestKey,
  type AgentScope,
  type AgentAudit,
} from '../../contracts/src/agents.js';
import { AppError, digest, id, iso, once, requireRow, type CommandBoundary } from './common.js';
import { LOCKS } from '../../storage/src/locks.js';

export type AgentPrincipal = { id: string; tokenHash: string; scopes: AgentScope[] };
const unauthorized = () => new AppError('Agent 凭据无效、已到期或已撤销。', 401, 'agent_unauthorized');
function credentialDTO(row: Row) {
  return AgentCredential.parse({
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    active: row.active,
    dailyWriteLimit: row.daily_write_limit,
    writesToday: row.current_writes,
  });
}
const credentialColumns =
  "*,(revoked_at IS NULL AND expires_at>now()) AS active,CASE WHEN write_day=(now() AT TIME ZONE 'UTC')::date THEN writes_today ELSE 0 END AS current_writes";

export class AgentAccess {
  constructor(readonly store: Store) {}
  async list() {
    return (
      await this.store.rows(
        `SELECT ${credentialColumns} FROM app.agent_credentials ORDER BY active DESC,created_at DESC,id LIMIT 100`,
      )
    ).map(credentialDTO);
  }
  async issue(key: string, input: unknown) {
    const data = CreateAgent.parse(input);
    data.scopes = [...new Set(data.scopes)].sort();
    let token: string | null = null;
    const result = await this.store.transaction((tx) =>
      once(tx, 'agent.issue:' + AgentRequestKey.parse(key), 'agent.issue', data, async () => {
        await tx.exec('SELECT pg_advisory_xact_lock($1)', [LOCKS.agentCredentials]);
        const count = await tx.one(
          'SELECT count(*) n FROM app.agent_credentials WHERE revoked_at IS NULL AND expires_at>now()',
        );
        if (Number(count!.n) >= 30)
          throw new AppError('最多保留 30 个有效连接，请先撤销不再使用的连接。', 409, 'agent_limit');
        token = 'yeux_agent_' + randomBytes(32).toString('hex');
        const agentId = id();
        await tx.exec(
          `INSERT INTO app.agent_credentials(id,name,token_hash,scopes,expires_at,daily_write_limit)
        VALUES($1,$2,$3,$4,now()+$5*interval '1 day',$6)`,
          [agentId, data.name, digest(token), JSON.stringify(data.scopes), data.expiresInDays, data.dailyWriteLimit],
        );
        return { agentId };
      }),
    );
    const row = await requireRow(this.store, `SELECT ${credentialColumns} FROM app.agent_credentials WHERE id=$1`, [
      result.agentId,
    ]);
    // A lost response can be retried without minting another credential. The secret cannot be recovered.
    return { credential: credentialDTO(row), token };
  }
  async revoke(agentId: string) {
    await this.store.transaction(async (tx) => {
      await requireRow(tx, 'SELECT id FROM app.agent_credentials WHERE id=$1 FOR UPDATE', [agentId]);
      await tx.exec('UPDATE app.agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1', [agentId]);
    });
    return { ok: true };
  }
  async authenticate(authorization: string | undefined): Promise<AgentPrincipal> {
    if (!authorization || !/^Bearer yeux_agent_[a-f0-9]{64}$/.test(authorization)) throw unauthorized();
    const tokenHash = digest(authorization.slice(7));
    const row = await this.store.one(
      `UPDATE app.agent_credentials SET last_used_at=now(),
      request_count=CASE WHEN request_window<=now()-interval '1 minute' THEN 1 ELSE LEAST(request_count+1,61) END,
      request_window=CASE WHEN request_window<=now()-interval '1 minute' THEN now() ELSE request_window END
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING id,scopes,request_count`,
      [tokenHash],
    );
    if (!row) throw unauthorized();
    if (row.request_count > 60) throw new AppError('Agent 请求过于频繁，请一分钟后重试。', 429, 'agent_rate_limited');
    return { id: row.id, tokenHash, scopes: row.scopes };
  }
  private async allowed(tx: Tx, actor: AgentPrincipal, scope: AgentScope, lock = false) {
    const row = await tx.one(
      `SELECT ${credentialColumns} FROM app.agent_credentials WHERE id=$1 AND token_hash=$2${lock ? ' FOR UPDATE' : ''}`,
      [actor.id, actor.tokenHash],
    );
    if (!row || !row.active) throw unauthorized();
    if (!row.scopes.includes(scope)) throw new AppError('此连接没有这项操作权限。', 403, 'agent_scope_denied');
    return row;
  }
  async invoke<T>(actor: AgentPrincipal, operation: string, scope: AgentScope, work: (auditId: string) => Promise<T>) {
    const auditId = id();
    await this.store.exec("INSERT INTO app.agent_audit(id,agent_id,operation,outcome) VALUES($1,$2,$3,'started')", [
      auditId,
      actor.id,
      operation,
    ]);
    try {
      await this.allowed(this.store, actor, scope);
      const result = await work(auditId);
      await this.store.exec(
        "UPDATE app.agent_audit SET outcome='succeeded',finished_at=now() WHERE id=$1 AND outcome='started'",
        [auditId],
      );
      return result;
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : error instanceof ZodError ? 'invalid_request' : 'operation_failed';
      const outcome =
        error instanceof AppError && [401, 403].includes(error.status)
          ? 'denied'
          : error instanceof AppError && error.status === 429
            ? 'limited'
            : 'failed';
      // Keep a committed business result authoritative if delivering its HTTP response fails.
      await this.store.exec(
        "UPDATE app.agent_audit SET outcome=$2,error_code=$3,finished_at=now() WHERE id=$1 AND outcome='started'",
        [auditId, outcome, code],
      );
      throw error;
    }
  }
  boundary(actor: AgentPrincipal, scope: AgentScope, auditId: string): CommandBoundary {
    return async (tx, key, operation, input, work) => {
      const expected = { 'goals:create': 'goal.create', 'tasks:create': 'session.create' }[
        scope as 'goals:create' | 'tasks:create'
      ];
      if (
        scope === 'devices:request'
          ? !/^device\.request:[0-9a-f-]{36}$/.test(operation)
          : !expected || operation !== expected
      )
        throw new AppError('Agent 不支持这项写入。', 403, 'agent_scope_denied');
      const credential = await this.allowed(tx, actor, scope, true);
      const commandKey = 'agent:' + actor.id + ':' + digest(AgentRequestKey.parse(key));
      const result = await once(tx, commandKey, operation, input, async () => {
        if (credential.current_writes >= credential.daily_write_limit)
          throw new AppError('已达到此连接的每日创建额度；次日 UTC 零点恢复。', 429, 'agent_write_limited');
        const response = await work();
        await tx.exec(
          "UPDATE app.agent_credentials SET writes_today=$2,write_day=(now() AT TIME ZONE 'UTC')::date WHERE id=$1",
          [actor.id, credential.current_writes + 1],
        );
        return response;
      });
      const response = result as Record<string, unknown>;
      await tx.exec(
        "UPDATE app.agent_audit SET outcome='succeeded',command_key=$2,entity_id=$3,finished_at=now() WHERE id=$1",
        [auditId, commandKey, response?.goalId ?? response?.sessionId ?? response?.id ?? null],
      );
      return result;
    };
  }
  async audit(page = 0): Promise<{ items: AgentAudit[]; total: number }> {
    return this.store.snapshot(async (tx) => ({
      total: Number((await tx.one('SELECT count(*) n FROM app.agent_audit'))!.n),
      items: (
        await tx.rows(
          `SELECT a.*,c.name FROM app.agent_audit a JOIN app.agent_credentials c ON c.id=a.agent_id
        ORDER BY a.created_at DESC,a.id LIMIT 30 OFFSET $1`,
          [page * 30],
        )
      ).map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        agentName: row.name,
        operation: row.operation,
        outcome: row.outcome,
        errorCode: row.error_code,
        entityId: row.entity_id,
        createdAt: iso(row.created_at),
      })),
    }));
  }
}
