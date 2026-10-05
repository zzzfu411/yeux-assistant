import { describe, it, expect } from 'vitest';
import {
  AddSimulatedDevice,
  RequestDeviceCommand,
  DecideDeviceCommand,
  ResolveDeviceCommand,
} from '../packages/contracts/src/devices.js';
import { SimulatedLamp, capability } from '../packages/core/src/devices/adapters.js';
import type { Store } from '../packages/storage/src/index.js';

describe('device input and registered capability boundaries', () => {
  const lamp = new SimulatedLamp({} as Store);
  it('accepts only explicit bounded device requests', () => {
    expect(
      RequestDeviceCommand.parse({ revision: 1, capability: 'power.set', arguments: { power: true } }).arguments,
    ).toEqual({ power: true });
    expect(RequestDeviceCommand.safeParse({ revision: 0, capability: 'power.set', arguments: {} }).success).toBe(false);
    expect(
      RequestDeviceCommand.safeParse({ revision: 1, capability: 'power.set', arguments: {}, url: 'http://device' })
        .success,
    ).toBe(false);
    expect(
      RequestDeviceCommand.safeParse({ revision: 1, capability: 'power.set', arguments: { text: 'x'.repeat(9000) } })
        .success,
    ).toBe(false);
  });
  it('requires registered capability and exact typed arguments', () => {
    expect(() => capability(lamp, 'shell.run')).toThrow('设备不支持');
    const action = capability(lamp, 'power.set');
    expect(action.schema.safeParse({ power: 'true' }).success).toBe(false);
    expect(action.schema.safeParse({ power: true, command: 'echo injected' }).success).toBe(false);
    expect(action.matches({ power: true }, { power: false })).toBe(false);
    expect(action.matches({ power: true }, { accepted: true })).toBe(false);
    expect(action.matches({ power: true }, { power: true })).toBe(true);
  });
  it('rejects capabilities without an explicit implementation version', () => {
    expect(() =>
      capability(
        {
          id: lamp.id,
          version: '',
          mode: lamp.mode,
          capabilities: lamp.capabilities,
          execute: lamp.execute.bind(lamp),
          readState: lamp.readState.bind(lamp),
        },
        'power.set',
      ),
    ).toThrow('版本');
    expect(() =>
      capability(
        {
          id: lamp.id,
          version: lamp.version,
          mode: lamp.mode,
          capabilities: lamp.capabilities.map((item) => ({ ...item, version: '' })),
          execute: lamp.execute.bind(lamp),
          readState: lamp.readState.bind(lamp),
        },
        'power.set',
      ),
    ).toThrow('版本');
  });
  it('requires an exact digest, revision and a nonempty manual verification note', () => {
    expect(DecideDeviceCommand.safeParse({ revision: 1, digest: 'short', approve: true }).success).toBe(false);
    expect(ResolveDeviceCommand.safeParse({ revision: 1, outcome: 'executed', note: ' ' }).success).toBe(false);
    expect(AddSimulatedDevice.parse({ name: '  台灯  ' }).name).toBe('台灯');
    expect(AddSimulatedDevice.safeParse({ name: '台灯', adapter: 'host.shell' }).success).toBe(false);
  });
});
