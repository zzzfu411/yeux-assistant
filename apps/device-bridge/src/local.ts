import type { BridgeCall } from '../../../packages/contracts/src/device-bridge.js';
export type LocalDevice<Input = unknown, State = Record<string, unknown>> = {
  read(signal: AbortSignal, call?: BridgeCall): Promise<State>;
  execute(input: Input, signal: AbortSignal, call?: BridgeCall): Promise<void>;
  evidence?(signal: AbortSignal, call: BridgeCall): Promise<Buffer | null>;
};
/** Only for errors proven to happen before a write was dispatched. */
export class LocalNotApplied extends Error {
  constructor(readonly effect: 'not_applied' | 'blocked' | 'login_required') {
    super(effect);
  }
}
