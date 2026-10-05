import { z } from 'zod';

const DeviceId=z.string().uuid();
const Revision=z.number().int().positive();
export const DeviceArguments=z.record(z.string().max(80),z.json()).refine(value=>JSON.stringify(value).length<=8192,'设备参数过长。');
export const AddSimulatedDevice=z.object({name:z.string().trim().min(1).max(80).default('演示台灯')}).strict();
export const UpdateDevice=z.object({revision:Revision,enabled:z.boolean()}).strict();
export const DeviceControlInput=UpdateDevice;
export const RequestDeviceCommand=z.object({revision:Revision,capability:z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/),arguments:DeviceArguments}).strict();
export const DecideDeviceCommand=z.object({revision:Revision,digest:z.string().regex(/^[a-f0-9]{64}$/),approve:z.boolean()}).strict();
export const CancelDeviceCommand=z.object({revision:Revision}).strict();
export const ResolveDeviceCommand=z.object({revision:Revision,outcome:z.enum(['executed','not_executed']),note:z.string().trim().min(1).max(1000)}).strict();
export const DeviceCommandState=z.enum(['pending','approved','executing','succeeded','failed','uncertain','rejected','cancelled','expired','resolved']);
export const DeviceCapability=z.object({id:z.string(),label:z.string(),choices:z.array(z.object({label:z.string(),arguments:DeviceArguments}))});
export const Device=z.object({id:DeviceId,name:z.string(),adapter:z.string(),mode:z.enum(['simulation','physical']),enabled:z.boolean(),revision:Revision,available:z.boolean(),connection:z.object({online:z.boolean(),lastSeenAt:z.string().nullable(),expiresAt:z.string(),revoked:z.boolean()}).nullable().optional(),capabilities:z.array(DeviceCapability),observedState:DeviceArguments.nullable(),observedAt:z.string().nullable()});
export type Device=z.infer<typeof Device>;
export const DeviceCommand=z.object({
  id:DeviceId,deviceId:DeviceId,deviceName:z.string(),mode:z.enum(['simulation','physical']),
  capability:z.string(),arguments:DeviceArguments,summary:z.string(),digest:z.string(),
  state:DeviceCommandState,revision:Revision,expiresAt:z.string(),createdAt:z.string(),updatedAt:z.string(),
  error:z.string(),receipt:z.object({source:z.enum(['simulation','device','user_report']),before:DeviceArguments.optional(),after:DeviceArguments.optional(),checkedAt:z.string(),outcome:z.enum(['verified','executed','not_executed']),note:z.string().optional()}).nullable()
});
export type DeviceCommand=z.infer<typeof DeviceCommand>;
export type DeviceOverview={control:{enabled:boolean;revision:number};devices:Device[];workerOnline:boolean;serverTime:string};
