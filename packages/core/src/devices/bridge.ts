import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Row, Store, Tx } from '../../../storage/src/index.js';
import {
  AudioInput,
  AudioState,
  BridgePoll,
  BridgeReport,
  CreateDeviceBridge,
  type BridgeCall,
  type BridgeResult,
} from '../../../contracts/src/device-bridge.js';
import { AppError, digest, event, id, iso, notify, once, requireRow } from '../common.js';
import { DeviceNotApplied, type DeviceAdapter, type ExecutionContext } from './driver.js';

export type BridgePrincipal = { deviceId: string; tokenHash: string };
const denied = () => new AppError('设备连接无效、已到期或已撤销。', 401, 'device_bridge_unauthorized');
const stale = () => new AppError('设备指令已失效，请停止本次操作。', 409, 'device_bridge_stale');

export class DeviceBridges {
  constructor(readonly store: Store) {}
  async issue(key: string, input: unknown) {
    const data = CreateDeviceBridge.parse(input);
    let token: string | null = null;
    const result = await this.store.transaction((tx) =>
      once(tx, key, 'device.bridge.issue', data, async () => {
        await tx.one('SELECT singleton FROM app.device_control WHERE singleton=true FOR UPDATE');
        if (Number((await tx.one('SELECT count(*) n FROM app.devices'))!.n) >= 100)
          throw new AppError('设备数量已达到 100 台上限。');
        const deviceId = id();
        token = 'yeux_device_' + randomBytes(32).toString('hex');
        await tx.exec('INSERT INTO app.devices(id,name,adapter) VALUES($1,$2,$3)', [deviceId, data.name, data.adapter]);
        const row = await requireRow(
          tx,
          `INSERT INTO app.device_bridges(device_id,token_hash,expires_at)
        VALUES($1,$2,now()+$3*interval '1 day') RETURNING expires_at`,
          [deviceId, digest(token), data.expiresInDays],
        );
        await event(tx, 'device.created', deviceId);
        return { deviceId, adapter: data.adapter, expiresAt: iso(row.expires_at) };
      }),
    );
    return { ...result, token };
  }
  async authenticate(raw: string | undefined): Promise<BridgePrincipal> {
    if (!raw || !/^Bearer yeux_device_[a-f0-9]{64}$/.test(raw)) throw denied();
    const tokenHash = digest(raw.slice(7));
    const row = await this.store.one(
      `UPDATE app.device_bridges SET
      request_count=CASE WHEN request_window<=now()-interval '1 minute' THEN 1 ELSE LEAST(request_count+1,181) END,
      request_window=CASE WHEN request_window<=now()-interval '1 minute' THEN now() ELSE request_window END
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING device_id,request_count`,
      [tokenHash],
    );
    if (!row) throw denied();
    if (row.request_count > 180) throw new AppError('设备请求过于频繁，请稍后重试。', 429, 'device_bridge_limited');
    return { deviceId: row.device_id, tokenHash };
  }
  private async locked(tx: Tx, actor: BridgePrincipal) {
    const control = await requireRow(tx, 'SELECT * FROM app.device_control WHERE singleton=true FOR UPDATE');
    const device = await requireRow(tx, 'SELECT * FROM app.devices WHERE id=$1 FOR UPDATE', [actor.deviceId]);
    const bridge = await tx.one(
      'SELECT *,expires_at>clock_timestamp() AS valid FROM app.device_bridges WHERE device_id=$1 FOR UPDATE',
      [actor.deviceId],
    );
    if (!bridge || bridge.token_hash !== actor.tokenHash || bridge.revoked_at || !bridge.valid) throw denied();
    return { control, device };
  }
  private async current(tx: Tx, actor: BridgePrincipal, callId: string, lease: string) {
    const { control, device } = await this.locked(tx, actor);
    const call = await requireRow(tx, 'SELECT * FROM app.device_bridge_calls WHERE id=$1 AND device_id=$2 FOR UPDATE', [
      callId,
      actor.deviceId,
    ]);
    if (call.lease !== lease) throw stale();
    const command = await requireRow(tx, 'SELECT * FROM app.device_commands WHERE id=$1', [call.command_id]);
    const valid =
      control.enabled &&
      device.enabled &&
      command.state === 'executing' &&
      command.execution_token === call.execution_token &&
      command.payload.deviceRevision === device.revision &&
      command.payload.controlRevision === control.revision &&
      command.payload.adapter === device.adapter &&
      command.payload.adapterVersion === '1' &&
      digest(command.payload) === command.digest;
    return {
      call,
      command,
      valid:
        Boolean(valid) &&
        Boolean((await tx.one('SELECT $1::timestamptz>clock_timestamp() AS valid', [call.deadline]))!.valid),
    };
  }
  async poll(actor: BridgePrincipal, input: unknown): Promise<{ call: BridgeCall | null }> {
    const data = BridgePoll.parse(input);
    return this.store.transaction(async (tx) => {
      const { control, device } = await this.locked(tx, actor);
      if (device.adapter !== data.adapter) throw stale();
      await tx.exec('UPDATE app.device_bridges SET last_seen_at=clock_timestamp() WHERE device_id=$1', [
        actor.deviceId,
      ]);
      if (!control.enabled || !device.enabled) return { call: null };
      const row = await tx.one(
        `SELECT c.*,d.payload,d.digest FROM app.device_bridge_calls c JOIN app.device_commands d ON d.id=c.command_id
        WHERE c.device_id=$1 AND c.state='pending' AND c.deadline>clock_timestamp()
          AND d.state='executing' AND d.execution_token=c.execution_token
          AND (d.payload->>'deviceRevision')::int=$2 AND (d.payload->>'controlRevision')::int=$3
        ORDER BY c.created_at,c.id LIMIT 1 FOR UPDATE OF c`,
        [actor.deviceId, device.revision, control.revision],
      );
      if (!row) return { call: null };
      if (
        row.payload.adapter !== data.adapter ||
        row.payload.adapterVersion !== data.version ||
        digest(row.payload) !== row.digest
      )
        throw stale();
      const lease = id();
      await tx.exec("UPDATE app.device_bridge_calls SET state='claimed',lease=$2 WHERE id=$1", [row.id, lease]);
      return {
        call: {
          id: row.id,
          lease,
          deviceId: actor.deviceId,
          commandId: row.command_id,
          adapter: data.adapter,
          version: data.version,
          kind: row.kind,
          capability: row.payload.capability,
          arguments: row.payload.arguments,
        },
      };
    });
  }
  async start(actor: BridgePrincipal, callId: string, lease: string) {
    return this.store.transaction(async (tx) => {
      const { call, valid } = await this.current(tx, actor, callId, lease);
      if (!valid || call.state !== 'claimed') throw stale();
      const row = await requireRow(
        tx,
        `UPDATE app.device_bridge_calls SET state='started',
        active_until=LEAST(deadline,clock_timestamp()+interval '5 seconds') WHERE id=$1
        RETURNING GREATEST(0,FLOOR(EXTRACT(epoch FROM active_until-clock_timestamp())*1000))::integer AS remaining`,
        [callId],
      );
      return { remainingMs: row.remaining as number };
    });
  }
  async report(actor: BridgePrincipal, callId: string, input: unknown) {
    const data = BridgeReport.parse(input),
      hash = digest(data.result);
    return this.store.transaction(async (tx) => {
      const { call, valid } = await this.current(tx, actor, callId, data.lease);
      if (call.state === 'completed') {
        if (call.result_digest !== hash) throw stale();
        return { ok: true };
      }
      if (
        !valid ||
        call.state !== 'started' ||
        !(await tx.one('SELECT $1::timestamptz>clock_timestamp() AS active', [call.active_until]))!.active
      )
        throw stale();
      if (data.result.ok) {
        if (call.kind === 'read') AudioState.parse(data.result.state);
        else if (data.result.state !== undefined) throw new AppError('执行回执不能替代独立状态读取。');
      }
      await tx.exec(
        "UPDATE app.device_bridge_calls SET state='completed',result=$2,result_digest=$3,finished_at=clock_timestamp() WHERE id=$1",
        [callId, JSON.stringify(data.result), hash],
      );
      return { ok: true };
    });
  }
  async revoke(key: string, deviceId: string) {
    return this.store.transaction((tx) =>
      once(tx, key, 'device.bridge.revoke:' + deviceId, {}, async () => {
        await tx.one('SELECT singleton FROM app.device_control WHERE singleton=true FOR UPDATE');
        await requireRow(tx, 'SELECT * FROM app.devices WHERE id=$1 FOR UPDATE', [deviceId]);
        await requireRow(tx, 'SELECT * FROM app.device_bridges WHERE device_id=$1 FOR UPDATE', [deviceId]);
        await tx.exec('UPDATE app.device_bridges SET revoked_at=coalesce(revoked_at,now()) WHERE device_id=$1', [
          deviceId,
        ]);
        await tx.exec(
          'UPDATE app.devices SET enabled=false,revision=revision+1,observed_state=NULL,observed_at=NULL,updated_at=now() WHERE id=$1',
          [deviceId],
        );
        const rows = await tx.rows(
          "UPDATE app.device_commands SET state=CASE WHEN state='executing' THEN 'uncertain' ELSE 'cancelled' END,revision=revision+1,error='设备连接已撤销；已开始的操作请核实实际结果。',updated_at=now(),finished_at=now() WHERE device_id=$1 AND state IN ('pending','approved','executing') RETURNING *",
          [deviceId],
        );
        for (const row of rows) {
          await event(tx, 'device.command.updated', row.id, { deviceId, state: row.state });
          if (row.state === 'uncertain')
            await notify(
              tx,
              'device-command:' + row.id + ':uncertain',
              null,
              row.payload.deviceName + ' · 结果待核实',
              row.error,
            );
        }
        await tx.exec(
          "UPDATE app.device_bridge_calls SET state='cancelled' WHERE device_id=$1 AND state IN ('pending','claimed','started')",
          [deviceId],
        );
        await event(tx, 'device.updated', deviceId);
        return { ok: true };
      }),
    );
  }
}

/** Only a registered profile can request RPCs; public input never contains a URL or program. */
export class BridgedAudio implements DeviceAdapter {
  readonly id = 'macos.audio';
  readonly version = '1';
  readonly mode = 'physical' as const;
  readonly capabilities = [
    {
      id: 'audio.volume.set',
      version: '1',
      label: '输出音量',
      schema: AudioInput,
      choices: [0, 10, 25, 50].map((percent) => ({ label: '音量 ' + percent + '%', arguments: { percent } })),
      summary: (input: Record<string, unknown>) => '将默认输出音量设为 ' + input.percent + '%（保持静音设置）',
      matches: (input: Record<string, unknown>, state: Record<string, unknown>, before?: Record<string, unknown>) =>
        AudioState.safeParse(state).success && state.volume === input.percent && state.muted === before?.muted,
    },
  ];
  constructor(readonly store: Store) {}
  async validateDevice(tx: Tx, deviceId: string) {
    const row = await tx.one(
      'SELECT device_id FROM app.device_bridges WHERE device_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
      [deviceId],
    );
    if (!row) throw new AppError('设备连接已到期或已撤销，请重新连接。', 409, 'device_bridge_unavailable');
  }
  private async rpc(deviceId: string, kind: 'read' | 'execute', context: ExecutionContext): Promise<BridgeResult> {
    context.signal.throwIfAborted();
    const phase = kind === 'execute' ? 'write' : context.phase || 'before',
      callId = id();
    const inserted = await this.store.one(
      `INSERT INTO app.device_bridge_calls(id,device_id,command_id,execution_token,kind,phase,deadline)
      SELECT $1,device_id,id,execution_token,$4,$5,execution_deadline FROM app.device_commands
      WHERE id=$2 AND device_id=$3 AND state='executing' AND execution_token=$6 AND execution_deadline>clock_timestamp() RETURNING id`,
      [callId, context.commandId, deviceId, kind, phase, context.token],
    );
    if (!inserted) throw new DeviceNotApplied('Command is no longer current');
    try {
      for (;;) {
        context.signal.throwIfAborted();
        const row = await requireRow(
          this.store,
          'SELECT state,result,deadline>clock_timestamp() AS valid FROM app.device_bridge_calls WHERE id=$1',
          [callId],
        );
        if (row.state === 'completed') return row.result as BridgeResult;
        if (row.state === 'cancelled' || !row.valid) throw stale();
        await delay(75, undefined, { signal: context.signal });
      }
    } finally {
      await this.store.exec(
        "UPDATE app.device_bridge_calls SET state='cancelled' WHERE id=$1 AND state IN ('pending','claimed','started')",
        [callId],
      );
      // Keep the Worker slot until any issued local execution grant has elapsed.
      // A completed reply already certifies that the local subprocess has been reaped.
      const pending = await this.store.one(
        "SELECT EXTRACT(epoch FROM active_until-clock_timestamp())*1000 AS remaining FROM app.device_bridge_calls WHERE id=$1 AND state='cancelled'",
        [callId],
      );
      const remaining = Math.min(5000, Math.max(0, Math.ceil(Number(pending?.remaining || 0))));
      if (remaining) await delay(remaining);
    }
  }
  async readState(deviceId: string, signal: AbortSignal, context?: ExecutionContext) {
    if (!context) throw new DeviceNotApplied('A bounded execution context is required');
    const result = await this.rpc(deviceId, 'read', { ...context, signal });
    if (!result.ok) throw new DeviceNotApplied('Device state could not be read');
    return AudioState.parse(result.state);
  }
  async execute(deviceId: string, _capability: string, input: Record<string, unknown>, context: ExecutionContext) {
    AudioInput.parse(input);
    const result = await this.rpc(deviceId, 'execute', context);
    if (!result.ok) {
      if (result.effect === 'not_applied') throw new DeviceNotApplied('Local executor did not dispatch the action');
      throw new Error('Device action needs verification');
    }
  }
}
