import type { PgBoss } from 'pg-boss';
import type { Row,Store,Tx } from '../../../storage/src/index.js';
import { AddSimulatedDevice,UpdateDevice,DeviceControlInput,RequestDeviceCommand,DecideDeviceCommand,CancelDeviceCommand,ResolveDeviceCommand,DeviceArguments, type Device, type DeviceCommand, type DeviceOverview } from '../../../contracts/src/devices.js';
import { AppError,checkVersion,digest,event,id,iso,notify,once,requireRow,type CommandBoundary } from '../common.js';
import { DeviceNotApplied,capability,publicCapabilities,registeredAdapters,type DeviceAdapter } from './adapters.js';

export const DEVICE_QUEUE='device-execute';
const openStates=['pending','approved','executing','uncertain'];
const unknownResult='执行结果待核实，请检查设备；系统不会自动重发。';
function commandDTO(row:Row):DeviceCommand {
  return {id:row.id,deviceId:row.device_id,deviceName:row.payload.deviceName,mode:row.payload.mode,capability:row.payload.capability,arguments:row.payload.arguments,summary:row.summary,digest:row.digest,state:row.state,revision:row.revision,expiresAt:iso(row.expires_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),error:row.error,receipt:row.receipt};
}
export class DeviceActions {
  readonly adapters:ReadonlyMap<string,DeviceAdapter>;
  readonly timeoutMs:number;
  readonly boundary:CommandBoundary;
  constructor(readonly store:Store,readonly boss:PgBoss,options:{adapters?:ReadonlyMap<string,DeviceAdapter>;timeoutMs?:number;boundary?:CommandBoundary}={}) {
    this.boundary=options.boundary||once;
    this.adapters=options.adapters||registeredAdapters(store);this.timeoutMs=Math.max(10,Math.min(20000,options.timeoutMs??20000));
  }
  private adapter(name:string) {const found=this.adapters.get(name);if(!found)throw new AppError('设备适配器未安装或未启用。',409,'adapter_unavailable');return found;}
  private registeredCommand(command:Row) {
    const adapter=this.adapter(command.payload.adapter),action=capability(adapter,command.payload.capability);
    if(command.payload.adapterVersion!==adapter.version||command.payload.capabilityVersion!==action.version||command.payload.mode!==adapter.mode)throw new AppError('设备能力版本已变化，请重新选择操作。',409,'device_capability_changed');
    action.schema.parse(command.payload.arguments);return {adapter,action};
  }
  private command<T>(key:string,operation:string,input:unknown,work:(tx:Tx)=>Promise<T>) {return this.store.transaction(tx=>this.boundary(tx,key,operation,input,()=>work(tx)));}
  private async lockDevice(tx:Tx,deviceId:string) {
    const control=await requireRow(tx,'SELECT * FROM app.device_control WHERE singleton=true FOR UPDATE');
    const device=await requireRow(tx,'SELECT * FROM app.devices WHERE id=$1 FOR UPDATE',[deviceId]);
    return {control,device};
  }
  private async lockCommand(tx:Tx,commandId:string) {
    const before=await requireRow(tx,'SELECT device_id FROM app.device_commands WHERE id=$1',[commandId]);
    const locked=await this.lockDevice(tx,before.device_id);
    return {...locked,command:await requireRow(tx,'SELECT * FROM app.device_commands WHERE id=$1 FOR UPDATE',[commandId])};
  }
  private async transition(tx:Tx,command:Row,state:string,error='',receipt:unknown=null) {
    const row=await requireRow(tx,"UPDATE app.device_commands SET state=$2,error=$3,receipt=$4,revision=revision+1,updated_at=now(),finished_at=CASE WHEN $2 IN ('approved','executing','pending') THEN NULL ELSE now() END WHERE id=$1 RETURNING *",[command.id,state,error,receipt===null?null:JSON.stringify(receipt)]);
    if(['executing','uncertain'].includes(state))await tx.exec('UPDATE app.devices SET observed_state=NULL,observed_at=NULL WHERE id=$1',[row.device_id]);
    await event(tx,'device.command.updated',row.id,{deviceId:row.device_id,state});
    if(['succeeded','failed','uncertain'].includes(state))await notify(tx,'device-command:'+row.id+':'+state,null,(row.payload.mode==='simulation'?'演示 · ':'')+row.payload.deviceName+' · '+({succeeded:'操作已核验',failed:'操作未执行',uncertain:'结果待核实'} as Record<string,string>)[state],error||row.summary);
    return row;
  }
  private async invalidate(tx:Tx,deviceId?:string) {
    const rows=await tx.rows("SELECT * FROM app.device_commands WHERE state IN ('pending','approved','executing') AND ($1::text IS NULL OR device_id=$1) ORDER BY device_id,id FOR UPDATE",[deviceId??null]);
    for(const row of rows)await this.transition(tx,row,row.state==='executing'?'uncertain':'cancelled',row.state==='executing'?unknownResult:'设备控制已停用，原请求不再执行。');
  }
  async list():Promise<DeviceOverview> {
    return this.store.snapshot(async tx=>{
      const control=await requireRow(tx,'SELECT enabled,revision FROM app.device_control WHERE singleton=true');
      const status=await requireRow(tx,"SELECT now() AS server_time,EXISTS(SELECT 1 FROM app.health WHERE name='worker' AND heartbeat>now()-interval '20 seconds') AS worker_online");
      const rows=await tx.rows(`SELECT d.*,b.device_id AS bridged,b.last_seen_at,b.expires_at,b.revoked_at,
        (b.revoked_at IS NULL AND b.expires_at>now() AND b.last_seen_at>now()-interval '20 seconds') AS bridge_online
        FROM app.devices d LEFT JOIN app.device_bridges b ON b.device_id=d.id ORDER BY d.created_at,d.id LIMIT 100`);
      const devices=rows.map((row):Device=>{const adapter=this.adapters.get(row.adapter);return {id:row.id,name:row.name,adapter:row.adapter,mode:adapter?.mode||'physical',enabled:row.enabled,revision:row.revision,available:Boolean(adapter)&&(!row.bridged||Boolean(row.bridge_online)),connection:row.bridged?{online:Boolean(row.bridge_online),lastSeenAt:row.last_seen_at?iso(row.last_seen_at):null,expiresAt:iso(row.expires_at),revoked:Boolean(row.revoked_at)}:null,capabilities:adapter?publicCapabilities(adapter):[],observedState:row.observed_state,observedAt:row.observed_at?iso(row.observed_at):null};});
      return {control:{enabled:control.enabled,revision:control.revision},devices,workerOnline:status.worker_online,serverTime:iso(status.server_time)};
    });
  }
  async getCommand(commandId:string) {return commandDTO(await requireRow(this.store,'SELECT * FROM app.device_commands WHERE id=$1',[commandId]));}
  async history() {return (await this.store.rows("SELECT * FROM (SELECT * FROM app.device_commands WHERE state=ANY($1::text[]) UNION ALL (SELECT * FROM app.device_commands WHERE NOT(state=ANY($1::text[])) ORDER BY created_at DESC,id DESC LIMIT 50)) AS recent ORDER BY CASE WHEN state=ANY($1::text[]) THEN 0 ELSE 1 END,created_at DESC,id DESC",[openStates])).map(commandDTO);}
  async addSimulation(key:string,input:unknown) {
    const data=AddSimulatedDevice.parse(input);
    return this.command(key,'device.add-simulation',data,async tx=>{
      await tx.one('SELECT singleton FROM app.device_control WHERE singleton=true FOR UPDATE');
      if(Number((await tx.one('SELECT count(*) n FROM app.devices'))!.n)>=100)throw new AppError('设备数量已达到 100 台上限。');
      const deviceId=id();
      await tx.exec("INSERT INTO app.devices(id,name,adapter,observed_state,observed_at) VALUES($1,$2,'simulation.lamp','{\"power\":false}',now())",[deviceId,data.name]);
      await tx.exec('INSERT INTO app.device_simulation_state(device_id) VALUES($1)',[deviceId]);
      await event(tx,'device.created',deviceId);return {deviceId};
    });
  }
  async update(key:string,deviceId:string,input:unknown) {
    const data=UpdateDevice.parse(input);
    return this.command(key,'device.update:'+deviceId,data,async tx=>{
      const {device}=await this.lockDevice(tx,deviceId);checkVersion(device,data.revision);
      if(device.enabled!==data.enabled){await tx.exec('UPDATE app.devices SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1',[deviceId,data.enabled]);await this.invalidate(tx,deviceId);await event(tx,'device.updated',deviceId);}
      return {deviceId,revision:device.revision+(device.enabled===data.enabled?0:1)};
    });
  }
  async control(key:string,input:unknown) {
    const data=DeviceControlInput.parse(input);
    return this.command(key,'device.control',data,async tx=>{
      const row=await requireRow(tx,'SELECT * FROM app.device_control WHERE singleton=true FOR UPDATE');checkVersion(row,data.revision);
      if(row.enabled!==data.enabled){await tx.exec('UPDATE app.device_control SET enabled=$1,revision=revision+1 WHERE singleton=true',[data.enabled]);await this.invalidate(tx);await event(tx,'device.control',null,{enabled:data.enabled});}
      return {enabled:data.enabled,revision:row.revision+(row.enabled===data.enabled?0:1)};
    });
  }
  async request(key:string,deviceId:string,input:unknown) {
    const data=RequestDeviceCommand.parse(input);
    return this.command(key,'device.request:'+deviceId,data,async tx=>{
      const {control,device}=await this.lockDevice(tx,deviceId);checkVersion(device,data.revision);
      if(!control.enabled||!device.enabled)throw new AppError('设备控制已暂停，请先恢复。',409,'device_disabled');
      const prior=await tx.one("SELECT * FROM app.device_commands WHERE device_id=$1 AND state IN ('pending','approved') AND expires_at<=clock_timestamp() FOR UPDATE",[deviceId]);
      if(prior)await this.transition(tx,prior,'expired','确认已过期，请重新选择操作。');
      if(await tx.one('SELECT id FROM app.device_commands WHERE device_id=$1 AND state=ANY($2::text[])',[deviceId,openStates]))throw new AppError('请先处理这台设备已有的操作或核实记录。',409,'device_busy');
      const adapter=this.adapter(device.adapter),action=capability(adapter,data.capability),args=action.schema.parse(data.arguments);
      await adapter.validateDevice?.(tx,deviceId);
      const expiresAt=iso((await tx.one("SELECT clock_timestamp()+interval '5 minutes' AS deadline"))!.deadline);
      const payload={deviceId,deviceName:device.name,adapter:adapter.id,adapterVersion:adapter.version,mode:adapter.mode,deviceRevision:device.revision,controlRevision:control.revision,capability:action.id,capabilityVersion:action.version,arguments:args,expiresAt};
      const row=await requireRow(tx,'INSERT INTO app.device_commands(id,device_id,payload,digest,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id(),deviceId,JSON.stringify(payload),digest(payload),action.summary(args),expiresAt]);
      await event(tx,'device.command.updated',row.id,{deviceId,state:'pending'});return commandDTO(row);
    });
  }
  async decide(key:string,commandId:string,input:unknown) {
    const data=DecideDeviceCommand.parse(input);
    return this.command(key,'device.decide:'+commandId,data,async tx=>{
      const {control,device,command}=await this.lockCommand(tx,commandId);checkVersion(command,data.revision);
      if(command.state!=='pending')throw new AppError('该操作已被处理，请查看最新状态。',409,'state_conflict');
      if(command.digest!==data.digest||digest(command.payload)!==command.digest)throw new AppError('确认内容已变化，请重新选择操作。',409,'approval_mismatch');
      if(!data.approve)return commandDTO(await this.transition(tx,command,'rejected'));
      if((await tx.one('SELECT $1::timestamptz<=clock_timestamp() AS expired',[command.expires_at]))!.expired)return commandDTO(await this.transition(tx,command,'expired','确认已过期，请重新选择操作。'));
      if(!control.enabled||!device.enabled||control.revision!==command.payload.controlRevision||device.revision!==command.payload.deviceRevision)throw new AppError('设备或控制权限已变化，请重新选择操作。',409,'device_changed');
      try{this.registeredCommand(command);}catch(error){if(error instanceof AppError&&['device_capability_changed','adapter_version_missing'].includes(error.code))return commandDTO(await this.transition(tx,command,'cancelled','设备能力版本已变化，请重新选择操作。'));throw error;}
      const row=await this.transition(tx,command,'approved');
      await this.boss.send(DEVICE_QUEUE,{commandId},{db:tx.bossDb,singletonKey:commandId});return commandDTO(row);
    });
  }
  async cancel(key:string,commandId:string,input:unknown) {
    const data=CancelDeviceCommand.parse(input);
    return this.command(key,'device.cancel:'+commandId,data,async tx=>{
      const {command}=await this.lockCommand(tx,commandId);checkVersion(command,data.revision);
      if(!['pending','approved','executing'].includes(command.state))throw new AppError('当前操作已结束或需要核实。',409,'state_conflict');
      return commandDTO(await this.transition(tx,command,command.state==='executing'?'uncertain':'cancelled',command.state==='executing'?unknownResult:''));
    });
  }
  async resolve(key:string,commandId:string,input:unknown) {
    const data=ResolveDeviceCommand.parse(input);
    return this.command(key,'device.resolve:'+commandId,data,async tx=>{
      const before=await requireRow(tx,'SELECT device_id FROM app.device_commands WHERE id=$1',[commandId]);
      const lock=await tx.one('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['device:'+before.device_id]);
      if(!lock?.locked)throw new AppError('设备执行尚未退出，请稍后重新核实。',409,'device_execution_active');
      const {command}=await this.lockCommand(tx,commandId);checkVersion(command,data.revision);
      if(await tx.one("SELECT id FROM app.device_bridge_calls WHERE command_id=$1 AND state!='completed' AND active_until>clock_timestamp() LIMIT 1",[commandId]))throw new AppError('设备执行尚未退出，请稍后重新核实。',409,'device_execution_active');
      if(command.state!=='uncertain')throw new AppError('只有待核实的操作可以记录核实结果。',409,'state_conflict');
      return commandDTO(await this.transition(tx,command,'resolved','',{source:'user_report',outcome:data.outcome,note:data.note,checkedAt:new Date().toISOString()}));
    });
  }
  private async claim(commandId:string) {
    return this.store.transaction(async tx=>{
      const {control,device,command}=await this.lockCommand(tx,commandId);
      if(command.state!=='approved')return;
      if((await tx.one('SELECT $1::timestamptz<=clock_timestamp() AS expired',[command.expires_at]))!.expired){await this.transition(tx,command,'expired','排队期间已过期，请重新选择操作。');return;}
      if(!control.enabled||!device.enabled||control.revision!==command.payload.controlRevision||device.revision!==command.payload.deviceRevision||device.adapter!==command.payload.adapter||digest(command.payload)!==command.digest){await this.transition(tx,command,'cancelled','设备配置或控制权限已变化。');return;}
      try{const {adapter}=this.registeredCommand(command);await adapter.validateDevice?.(tx,command.device_id);}catch(error){const changed=error instanceof AppError&&['device_capability_changed','adapter_version_missing'].includes(error.code);await this.transition(tx,command,changed?'cancelled':'failed',changed?'设备能力版本已变化，请重新选择操作。':'设备能力或参数已变化，请重新选择操作。');return;}
      const row=await this.transition(tx,command,'executing');
      const token=id();await tx.exec("UPDATE app.device_commands SET execution_token=$2,started_at=clock_timestamp(),execution_deadline=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=$1",[commandId,token,this.timeoutMs]);
      return {...row,execution_token:token};
    });
  }
  async process(commandId:string,signal?:AbortSignal) {
    const before=await this.store.one('SELECT device_id FROM app.device_commands WHERE id=$1',[commandId]);if(!before)return;
    const lock=await this.store.pool.connect(),controller=new AbortController();
    let claimed:Row|undefined,timer:ReturnType<typeof setTimeout>|undefined,poll:ReturnType<typeof setInterval>|undefined,polling=false;
    const stop=()=>controller.abort();lock.on('error',stop);signal?.addEventListener('abort',stop,{once:true});
    try {
      if(!(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked',['device:'+before.device_id])).rows[0].locked)return;
      if(signal?.aborted)return;
      claimed=await this.claim(commandId);if(!claimed)return;
      const current=claimed,{adapter,action}=this.registeredCommand(current);
      timer=setTimeout(stop,this.timeoutMs);
      poll=setInterval(async()=>{if(polling||controller.signal.aborted)return;polling=true;try{const row=await this.store.one('SELECT state,execution_token FROM app.device_commands WHERE id=$1',[commandId]);if(row?.state!=='executing'||row.execution_token!==current.execution_token)stop();}catch{stop();}finally{polling=false;}},100);
      let phase:'read'|'write'|'verify'='read';
      let abortListener:()=>void=()=>{};
      const aborted=new Promise<never>((_,reject)=>{abortListener=()=>reject(new Error('device operation interrupted'));controller.signal.addEventListener('abort',abortListener,{once:true});if(controller.signal.aborted)abortListener();});
      const execution=(async()=>{
          const observedBefore=DeviceArguments.parse(await adapter.readState(current.device_id,controller.signal,{commandId,token:current.execution_token,signal:controller.signal,phase:'before'}));controller.signal.throwIfAborted();
          phase='write';await adapter.execute(current.device_id,current.payload.capability,current.payload.arguments,{commandId,token:current.execution_token,signal:controller.signal});controller.signal.throwIfAborted();
          phase='verify';const after=DeviceArguments.parse(await adapter.readState(current.device_id,controller.signal,{commandId,token:current.execution_token,signal:controller.signal,phase:'after'}));controller.signal.throwIfAborted();
          if(!action.matches(current.payload.arguments,after,observedBefore))throw new Error('postcondition was not verified');
          return {source:adapter.mode==='simulation'?'simulation' as const:'device' as const,before:observedBefore,after,outcome:'verified' as const,checkedAt:new Date().toISOString()};
      })();
      try {
        const receipt=await Promise.race([aborted,execution]);
        await this.finish(current,'succeeded','',receipt);
      } catch(error) {
        const notApplied=(phase as string)==='read'||((phase as string)==='write'&&error instanceof DeviceNotApplied);
        await this.finish(current,notApplied?'failed':'uncertain',notApplied?'操作未执行，请检查设备连接后重新选择。':unknownResult);
      } finally {
        controller.signal.removeEventListener('abort',abortListener);controller.abort();
        // Keep the execution slot and device lock until the adapter has really stopped.
        // Only bounded adapters may be registered; a real process adapter must reap its child.
        await execution.catch(()=>{});
      }
    } finally {
      clearTimeout(timer);clearInterval(poll);controller.abort();signal?.removeEventListener('abort',stop);lock.off('error',stop);
      await lock.query('SELECT pg_advisory_unlock_all()').catch(()=>{});lock.release();
    }
  }
  private async finish(claim:Row,state:string,error:string,receipt:DeviceCommand['receipt']=null) {
    return this.store.transaction(async tx=>{
      const {command}=await this.lockCommand(tx,claim.id);
      if(command.state!=='executing'||command.execution_token!==claim.execution_token)return;
      await this.transition(tx,command,state,error,receipt);
      if(state==='succeeded'&&receipt?.after)await tx.exec('UPDATE app.devices SET observed_state=$2,observed_at=$3 WHERE id=$1',[command.device_id,JSON.stringify(receipt.after),receipt.checkedAt]);
    });
  }
  /** Only call while holding the exclusive Worker ownership lock. Never replay interrupted writes. */
  async recover() {
    const rows=await this.store.rows("SELECT id FROM app.device_commands WHERE state='executing'");
    for(const row of rows)await this.store.transaction(async tx=>{const {command}=await this.lockCommand(tx,row.id);if(command.state==='executing')await this.transition(tx,command,'uncertain',unknownResult);});
    await this.sweep();
  }
  async sweep() {
    const overdue=await this.store.rows("SELECT id FROM app.device_commands WHERE state='executing' AND execution_deadline<clock_timestamp()-interval '2 seconds' LIMIT 100");
    for(const row of overdue)await this.store.transaction(async tx=>{const {command}=await this.lockCommand(tx,row.id);if(command.state==='executing'&&(await tx.one("SELECT $1::timestamptz<clock_timestamp()-interval '2 seconds' AS overdue",[command.execution_deadline]))!.overdue)await this.transition(tx,command,'uncertain',unknownResult);});
    const rows=await this.store.rows("SELECT id FROM app.device_commands WHERE state IN ('pending','approved') ORDER BY created_at,id LIMIT 100");
    for(const row of rows)await this.store.transaction(async tx=>{
      const {command}=await this.lockCommand(tx,row.id);if(!['pending','approved'].includes(command.state))return;
      if((await tx.one('SELECT $1::timestamptz<=clock_timestamp() AS expired',[command.expires_at]))!.expired){await this.transition(tx,command,'expired','操作已过期，请重新选择。');return;}
      try{this.registeredCommand(command);}catch(error){if(error instanceof AppError&&['device_capability_changed','adapter_version_missing'].includes(error.code)){await this.transition(tx,command,'cancelled','设备能力版本已变化，请重新选择操作。');return;}}
      if(command.state==='approved'&&!(await this.boss.findJobs(DEVICE_QUEUE,{data:{commandId:command.id},db:tx.bossDb})).some(job=>['created','retry','active'].includes(job.state)))await this.boss.send(DEVICE_QUEUE,{commandId:command.id},{db:tx.bossDb,singletonKey:command.id});
    });
  }
}
