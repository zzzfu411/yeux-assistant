import { z } from 'zod';
import type { Device, DeviceCommand } from '../../../contracts/src/devices.js';
import type { Tx } from '../../../storage/src/index.js';
import { AppError } from '../common.js';

type Arguments=DeviceCommand['arguments'];
export type ExecutionContext={commandId:string;token:string;signal:AbortSignal;phase?:'before'|'after'};
export type Capability={id:string;version:string;label:string;schema:z.ZodType<Arguments>;choices:Array<{label:string;arguments:Arguments}>;summary:(input:Arguments)=>string;matches:(input:Arguments,state:Arguments,before?:Arguments)=>boolean};
export interface DeviceAdapter {
  readonly id:string;
  /** Increment when transport behavior or capability meaning changes. */
  readonly version:string;
  readonly mode:'simulation'|'physical';
  readonly capabilities:readonly Capability[];
  /** Must settle after abort within a documented bound; process adapters must terminate and reap their child. */
  execute(deviceId:string,capability:string,input:Arguments,context:ExecutionContext):Promise<void>;
  readState(deviceId:string,signal:AbortSignal,context?:ExecutionContext):Promise<Arguments>;
  validateDevice?(tx:Tx,deviceId:string):Promise<void>;
}
/** Use only when the adapter can prove it did not send or apply a write. */
export class DeviceNotApplied extends Error {}
export function capability(adapter:DeviceAdapter,name:string):Capability {
  const found=adapter.capabilities.find(item=>item.id===name);
  if(!found)throw new AppError('设备不支持这项操作。',400,'unsupported_capability');
  const version=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
  if(!version.test(adapter.version||'')||!version.test(found.version||''))throw new AppError('设备能力缺少有效版本，请完成接入后再操作。',409,'adapter_version_missing');
  return found;
}
export function publicCapabilities(adapter:DeviceAdapter):Device['capabilities'] {
  return adapter.capabilities.map(({id,label,choices})=>({id,label,choices}));
}
