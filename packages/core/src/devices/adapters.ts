import { z } from 'zod';
import type { Store } from '../../../storage/src/index.js';
import type { Device, DeviceCommand } from '../../../contracts/src/devices.js';
import { AppError } from '../common.js';

import { DeviceNotApplied, capability, type Capability, type DeviceAdapter, type ExecutionContext } from './driver.js';
import { BridgedAudio } from './bridge.js';
import { BridgedEhall } from './ehall.js';
export { DeviceNotApplied, capability, publicCapabilities } from './driver.js';
export type { Capability, DeviceAdapter, ExecutionContext } from './driver.js';
type Arguments = DeviceCommand['arguments'];
export class SimulatedLamp implements DeviceAdapter {
  readonly id = 'simulation.lamp';
  readonly version = '2';
  readonly mode = 'simulation' as const;
  readonly capabilities: Capability[] = [
    {
      id: 'power.set',
      version: '1',
      label: '灯光开关',
      schema: z.object({ power: z.boolean() }).strict(),
      choices: [
        { label: '开灯', arguments: { power: true } },
        { label: '关灯', arguments: { power: false } },
      ],
      summary: (input) => (input.power ? '开灯' : '关灯'),
      matches: (input, state) => state.power === input.power,
    },
  ];
  constructor(readonly store: Store) {}
  async execute(deviceId: string, name: string, input: Arguments, context: ExecutionContext) {
    const data = capability(this, name).schema.parse(input);
    context.signal.throwIfAborted();
    await this.store.transaction(async (tx) => {
      // SQL cancellation is bounded too; an aborted Promise alone does not stop a queued write.
      await tx.exec("SET LOCAL statement_timeout='2000ms'");
      await tx.exec("SET LOCAL lock_timeout='1500ms'");
      try {
        // Lock the target first. After any wait, read the command in a fresh statement snapshot.
        const target = await tx.one('SELECT device_id FROM app.device_simulation_state WHERE device_id=$1 FOR UPDATE', [
          deviceId,
        ]);
        context.signal.throwIfAborted();
        const claim = await tx.one(
          "SELECT id FROM app.device_commands WHERE id=$1 AND device_id=$2 AND state='executing' AND execution_token=$3 AND execution_deadline>clock_timestamp() FOR UPDATE",
          [context.commandId, deviceId, context.token],
        );
        if (!target || !claim) throw new DeviceNotApplied('Simulation claim is no longer current');
        context.signal.throwIfAborted();
        await tx.exec('UPDATE app.device_simulation_state SET power=$2 WHERE device_id=$1', [deviceId, data.power]);
        context.signal.throwIfAborted();
      } catch {
        // The callback throws before COMMIT, so the simulator's transactional write is rolled back.
        throw new DeviceNotApplied('Simulation operation rolled back before commit');
      }
    });
  }
  async readState(deviceId: string, signal: AbortSignal): Promise<Arguments> {
    signal.throwIfAborted();
    const row = await this.store.transaction(async (tx) => {
      await tx.exec("SET LOCAL statement_timeout='2000ms'");
      return tx.one('SELECT power FROM app.device_simulation_state WHERE device_id=$1', [deviceId]);
    });
    if (!row) throw new DeviceNotApplied('Simulation device does not exist');
    return { power: row.power };
  }
}
export function registeredAdapters(store: Store): ReadonlyMap<string, DeviceAdapter> {
  return new Map(
    [new SimulatedLamp(store), new BridgedAudio(store), new BridgedEhall(store)].map((adapter) => [
      adapter.id,
      adapter,
    ]),
  );
}
