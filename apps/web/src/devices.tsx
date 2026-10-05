import { useEffect,useMemo,useRef,useState,type FormEvent } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import type { Device,DeviceCommand,DeviceOverview } from '../../../packages/contracts/src/devices';
import { useAction,useApi,useDraft } from './api';
import { date,ErrorNotice,Heading,QueryState } from './ui';
import { DeviceConnection } from './device-connection';
import { Icon } from './icons';
import s from './styles.module.css';

const commandLabels:Record<DeviceCommand['state'],string>={pending:'待确认',approved:'等待执行',executing:'正在执行',succeeded:'已核验',failed:'未执行',uncertain:'待核实',rejected:'已放弃',cancelled:'已取消',expired:'已过期',resolved:'已人工核实'};
const shortId=(id:string)=>id.replace(/-/g,'').slice(-8);
function power(state:Device['observedState']){if(typeof state?.volume==='number')return '输出音量 '+state.volume+'%'+(state.muted?' · 静音':'');return state?.power===true?'开启':state?.power===false?'关闭':'尚未核验';}
function useDeviceData<T>(path:string,enabled=true){const api=useApi();return useQuery({queryKey:[path],queryFn:({signal})=>api.get<T>(path,signal),enabled,retry:1,staleTime:5000,refetchInterval:5000,refetchIntervalInBackground:false});}
function inTime(command:DeviceCommand,now:number){return Number.isFinite(now)&&Date.parse(command.expiresAt)>now;}

export function DevicesPage({commandId=''}:{commandId?:string}){
  const query=useDeviceData<DeviceOverview>('/devices'),history=useDeviceData<DeviceCommand[]>('/device-commands'),selected=useDeviceData<DeviceCommand>('/device-commands/'+encodeURIComponent(commandId),Boolean(commandId));
  const api=useApi(),action=useAction(),client=useQueryClient(),[name,setName]=useState<string|null>(null),[,tick]=useState(0),focused=useRef('');
  const data=query.data;
  // Advance from a server timestamp using a monotonic clock, independent of the browser's wall clock.
  const clock=useMemo(()=>({server:Date.parse(data?.serverTime||''),received:performance.now()}),[data?.serverTime,query.dataUpdatedAt]);
  const now=clock.server+performance.now()-clock.received;
  useEffect(()=>{const timer=setInterval(()=>tick(value=>value+1),1000);return()=>clearInterval(timer);},[]);
  const commands=history.data||[];
  const historyTarget=commands.find(row=>row.id===commandId),target=historyTarget&&(!selected.data||historyTarget.revision>selected.data.revision)?historyTarget:selected.data;
  const records=target?[target,...commands.filter(row=>row.id!==target.id)]:commands;
  useEffect(()=>{
    if(!commandId||!target||target.id!==commandId||focused.current===commandId)return;
    const frame=requestAnimationFrame(()=>{const node=document.getElementById('device-command-'+commandId);if(node){node.scrollIntoView({block:'start'});node.focus({preventScroll:true});focused.current=commandId;}});
    return()=>cancelAnimationFrame(frame);
  },[commandId,target?.id]);
  const refresh=()=>{void client.invalidateQueries();};
  const write=(path:string,body:unknown,method='POST')=>void action.run(()=>api.write(path,body,method),refresh);
  const openCommand=(id:string)=>{const hash='/devices?command='+encodeURIComponent(id);if(window.location.hash.slice(1)===hash){const node=document.getElementById('device-command-'+id);node?.scrollIntoView({block:'start'});node?.focus({preventScroll:true});}else window.location.hash=hash;};
  const preview=(device:Device,capability:string,args:Record<string,unknown>)=>void action.run(()=>api.write<DeviceCommand>('/devices/'+device.id+'/commands',{revision:device.revision,capability,arguments:args}),result=>{client.setQueryData(['/device-commands/'+result.id],result);refresh();openCommand(result.id);});
  let number=1;while(data?.devices.some(device=>device.name===(number===1?'演示台灯':'演示台灯 '+number)))number++;
  const defaultName=number===1?'演示台灯':'演示台灯 '+number;
  const add=(event:FormEvent)=>{event.preventDefault();const submitted=(name??defaultName).trim();if(!submitted)return;void action.run(()=>api.write('/devices/simulated',{name:submitted}),()=>{setName(current=>current===name?null:current);refresh();});};
  return <><Heading title="设备" action={<div className={s.deviceButtons}><button className={s.textButton} onClick={refresh}>刷新记录</button>{data&&<button className={s.secondary} disabled={action.busy} onClick={()=>write('/device-control',{revision:data.control.revision,enabled:!data.control.enabled},'PATCH')}>{data.control.enabled?'暂停全部设备':'恢复设备操作'}</button>}</div>}>查看状态，选择操作，核对执行结果。</Heading>
    <DeviceConnection/>
    <QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>
    {data&&<><div className={s.deviceIntro}><div><strong>演示设备仅用于体验操作流程</strong><p>真实设备需要先完成接入；演示台灯不会控制你的电脑或电器。</p></div><form className={s.deviceAdd} onSubmit={add}><label htmlFor="device-name">设备名称</label><div><input id="device-name" required maxLength={80} value={name??defaultName} onChange={event=>setName(event.target.value)}/><button className={s.secondary} disabled={action.busy||!(name??defaultName).trim()}><Icon name="plus"/>添加演示台灯</button></div></form></div>
      {!data.workerOnline&&<p className={s.notice} role="status">后台离线。确认后的操作会排队，仅在有效期内开始执行。恢复后台前可取消操作。</p>}
      {!data.control.enabled&&<p className={s.notice} role="status">设备操作已暂停。恢复后需要重新选择操作，旧请求不会自动执行。</p>}
      <p className={s.composerHint}>状态来自最近一次核验，刷新记录不会读取设备实时状态。</p>
      <div className={s.deviceGrid}>{data.devices.map(device=>{
        const active=commands.find(command=>command.deviceId===device.id&&(['executing','uncertain'].includes(command.state)||(['pending','approved'].includes(command.state)&&(!Number.isFinite(now)||inTime(command,now)))));
        const unresolved=active&&['executing','uncertain'].includes(active.state);
        return <article className={s.deviceCard} key={device.id} aria-label={device.name+' · '+shortId(device.id)}><div className={s.sectionHeading}><div><h2>{device.name}</h2><p className={s.deviceIdentity} title={device.id}>设备编号 {shortId(device.id)}</p></div><span className={s.status}>{device.mode==='simulation'?'演示设备':'真实设备'}</span></div><p className={s.devicePower}>{unresolved?'状态待核实':power(device.observedState)}{!device.enabled&&<span className={s.muted}> · 已停用</span>}</p>{device.connection&&<p className={s.muted}>{device.connection.revoked?'连接已撤销':device.connection.online?'执行器在线':'执行器离线或连接已到期'} · 有效至 {date(device.connection.expiresAt)}</p>}<p className={s.muted}>最近核验 {date(device.observedAt)||'暂无'}</p>
          {!device.available&&<p className={s.error}>设备尚未连接，请启动执行器并检查连接有效期。</p>}
          <div className={s.deviceButtons}>{device.capabilities.flatMap(cap=>cap.choices.map(choice=><button className={s.secondary} key={cap.id+':'+choice.label} disabled={action.busy||Boolean(active)||!device.available||!device.enabled||!data.control.enabled||history.isPending||Boolean(history.error)||Boolean(query.error)} onClick={()=>preview(device,cap.id,choice.arguments)}>{choice.label}</button>))}<button className={s.textButton} disabled={action.busy} onClick={()=>write('/devices/'+device.id,{revision:device.revision,enabled:!device.enabled},'PATCH')}>{device.enabled?'停用设备':'启用设备'}</button>{device.connection&&!device.connection.revoked&&<button className={s.textButton} disabled={action.busy} onClick={()=>write('/devices/'+device.id+'/revoke-bridge',{})}>撤销连接</button>}</div>
          {active&&<div className={s.devicePending}><span>{commandLabels[active.state]}</span><button className={s.textButton} onClick={()=>openCommand(active.id)}>查看操作</button></div>}
        </article>;
      })}</div>{data.devices.length===0&&<p className={s.empty}>尚未添加设备。可先添加演示台灯，体验预览、确认和结果核验。</p>}</>}
    <ErrorNotice error={action.error} onReload={()=>{action.setError(null);refresh();}}/>
    <section className={s.section}><h2>操作记录</h2>{commandId&&!target&&<QueryState pending={selected.isPending} error={selected.error} retry={()=>void selected.refetch()}/>}<QueryState pending={history.isPending} error={history.error} retry={()=>void history.refetch()}/>{(history.data||target)&&<>{records.length===0?<p className={s.empty}>选择设备上的操作按钮后，在这里确认执行。</p>:<div className={s.deviceRecords}>{records.map(command=><CommandCard command={command} key={command.id} now={now} verifiedOverview={!query.isError&&Boolean(data)}/>)}</div>}<p className={s.composerHint}>显示全部待处理操作与最近 50 条已结束记录；通过链接打开的记录会显示在首位。</p></>}</section>
  </>;
}
function CommandCard({command,now,verifiedOverview}:{command:DeviceCommand;now:number;verifiedOverview:boolean}){
  const api=useApi(),action=useAction(),client=useQueryClient(),[draft,setDraft,clear]=useDraft('device-verification.'+command.id,{note:''}),submittedRevision=useRef<number|null>(null);
  useEffect(()=>{if(action.error&&submittedRevision.current!==null&&command.revision>submittedRevision.current)action.setError(null);},[command.revision,action.error,action.setError]);
  const refresh=()=>{void client.invalidateQueries();};
  const write=(operation:string,body:unknown)=>{submittedRevision.current=command.revision;void action.run(()=>api.write<DeviceCommand>('/device-commands/'+command.id+'/'+operation,body),result=>{client.setQueryData(['/device-commands/'+command.id],result);if(operation==='resolve')clear();refresh();});};
  const prefix=command.mode==='simulation'?'演示 · ':'',expired=['pending','approved'].includes(command.state)&&Number.isFinite(now)&&!inTime(command,now);
  return <article id={'device-command-'+command.id} tabIndex={-1} className={s.deviceRecord} aria-label={command.deviceName+' · '+command.summary+' · '+shortId(command.deviceId)}><div className={s.sectionHeading}><h3>{prefix}{command.deviceName} · {command.summary}</h3><span className={`${s.status} ${command.state==='uncertain'?s.dangerText:command.state==='pending'?s.accentText:''}`}>{expired?'有效期已结束':commandLabels[command.state]}</span></div><p className={s.muted}>{date(command.createdAt)} · 设备编号 <span title={command.deviceId}>{shortId(command.deviceId)}</span></p>
    {command.state==='pending'&&<div className={s.deviceConfirmation}><p>即将对 <strong>{command.deviceName}</strong> 执行 <strong>{command.summary}</strong>。{command.mode==='simulation'?'本次仅改变演示状态。':''}</p><p className={s.muted}>确认截止：{date(command.expiresAt)}</p><div className={s.deviceButtons}><button className={s.primary} disabled={action.busy||!verifiedOverview||!inTime(command,now)} onClick={()=>write('decision',{revision:command.revision,digest:command.digest,approve:true})}>确认{command.summary}</button><button className={s.textButton} disabled={action.busy} onClick={()=>write('decision',{revision:command.revision,digest:command.digest,approve:false})}>放弃操作</button></div></div>}
    {expired&&<p className={s.notice}>有效期已结束，请重新选择操作。</p>}
    {['approved','executing'].includes(command.state)&&<><div className={s.deviceButtons}><button className={s.secondary} disabled={action.busy} onClick={()=>write('cancel',{revision:command.revision})}>{command.state==='executing'?'请求停止':'取消操作'}</button><span className={s.muted}>{command.state==='approved'?'执行截止：'+date(command.expiresAt):'关闭页面后仍会保留操作记录。'}</span></div>{command.state==='executing'&&<p className={s.muted}>请求停止会保留待核实记录，不能保证设备尚未执行。</p>}</>}
    {command.error&&<p className={command.state==='uncertain'?s.error:s.notice}>{command.error}</p>}
    {command.state==='uncertain'&&<div className={s.deviceConfirmation}><p>核对设备后填写结果。记录核实结果不会重新发送指令。</p><label htmlFor={'device-note-'+command.id}>核实记录</label><textarea id={'device-note-'+command.id} rows={2} maxLength={1000} value={draft.note} onChange={e=>setDraft({note:e.target.value})} placeholder="记录看到的实际状态和核实方式"/><div className={s.deviceButtons}><button className={s.secondary} disabled={action.busy||!draft.note.trim()} onClick={()=>write('resolve',{revision:command.revision,outcome:'executed',note:draft.note})}>确认已执行</button><button className={s.secondary} disabled={action.busy||!draft.note.trim()} onClick={()=>write('resolve',{revision:command.revision,outcome:'not_executed',note:draft.note})}>确认未执行</button></div></div>}
    {command.receipt&&<div className={s.deviceReceipt}>{command.receipt.source==='user_report'?<><p>本人核实：{command.receipt.outcome==='executed'?'已执行':'未执行'}</p><p className={s.prewrap}>{command.receipt.note}</p></>:<p>{command.receipt.source==='simulation'?'模拟状态':'设备状态'}已核验：{power(command.receipt.after||null)}</p>}<p className={s.muted}>{date(command.receipt.checkedAt)}</p></div>}
    <ErrorNotice error={action.error} onReload={()=>{action.setError(null);refresh();}}/>
  </article>;
}
