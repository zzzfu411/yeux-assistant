import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CreateGoal, CreateSession, Feedback, UpdateGoal, DraftInput, type Attempt, type Goal, type GoalDetail, type LearningSession, type SessionDetail, type SourceSummary, type Today } from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, navigate, QueryState, Result, SessionRows, SourcePicker, Sources, Status } from './ui';
import s from './styles.module.css';

const attemptSource:Record<Attempt['source'],string>={user_report:'含本人反馈',model_estimate:'模型估计',ungraded:'未评阅'};

function LegacyRecord({record,sessionId}:{record:Record<string,unknown>;sessionId:string}){
  let decoded:unknown=record.sources,invalid=false;
  if(typeof decoded==='string'){
    if(decoded.trim()){try{decoded=JSON.parse(decoded);}catch{invalid=true;decoded=[];}}
    else decoded=[];
  }
  if(decoded==null)decoded=[];
  if(!Array.isArray(decoded)){invalid=true;decoded=[];}
  const entries:Array<{path:string;text:string}>=[];
  for(const entry of decoded as unknown[]){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)){invalid=true;continue;}
    const item=entry as Record<string,unknown>,path=typeof item.path==='string'?item.path:'',text=typeof item.text==='string'?item.text:'';
    if(!path&&!text){invalid=true;continue;}
    if(item.path!==undefined&&typeof item.path!=='string'||item.text!==undefined&&typeof item.text!=='string')invalid=true;
    entries.push({path,text});
  }
  const packet=typeof record.packet==='string'?record.packet:record.packet==null?'':JSON.stringify(record.packet,null,2);
  const download=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json;charset=utf-8'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download=('迁移前记录-'+sessionId).replace(/[\\/:*?"<>|]/g,'_')+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <details className={s.disclosure}><summary>迁移前记录</summary>
    <p className={s.muted}>以下为迁移前保存的内容。历史引用未全部核验，不作为本轮的新证据。</p>
    {packet&&<section className={s.section}><h2>旧整理内容</h2><Result>{packet}</Result></section>}
    <section className={s.section}><h2>历史引用</h2>{entries.map((entry,index)=><div className={s.citation} key={index}><p className={s.prewrap}>{entry.path||'未记录路径'}</p><blockquote>{entry.text||'未记录摘录'}</blockquote></div>)}
      {invalid?<p className={s.muted}>部分历史引用格式无法展开，可下载完整记录核对。</p>:!entries.length&&<p className={s.muted}>没有保存历史引用。</p>}
    </section><div className={s.toolbar}><button type="button" className={s.secondary} onClick={download}>下载完整旧记录（JSON）</button></div>
  </details>;
}

export function TodayPage(){
  const query=useData<Today>('/today'),api=useApi(),action=useAction(),client=useQueryClient();
  const [draft,setDraft]=useDraft('new-goal',{title:'',outcome:'',sourceIds:[] as string[],mode:'goal'});
  const sources=useData<SourceSummary[]>('/sources');
  const submit=(e:FormEvent)=>{e.preventDefault();void action.run(async()=>{
    if(draft.mode==='goal')return api.write<{sessionId:string;goalId:string}>('/goals',CreateGoal.parse({title:draft.title.trim(),outcome:draft.outcome,sourceIds:draft.sourceIds}));
    return api.write<{sessionId:string}>('/sessions',CreateSession.parse({prompt:draft.title,kind:draft.mode}));
  },result=>{setDraft(current=>JSON.stringify(current)===JSON.stringify(draft)?{...current,title:'',outcome:''}:current);void client.invalidateQueries();navigate('/session/'+result.sessionId);});};
  return <><Heading title="今天，向前一步。">从一个目标开始，按自己的节奏继续。</Heading>
    <form onSubmit={submit} className={s.composer}>
      <label className={s.srOnly} htmlFor="new-goal">想学什么</label><textarea id="new-goal" maxLength={draft.mode==='goal'?200:30000} rows={3} placeholder="我想学会什么？" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/>
      <details className={s.composerOptions}><summary>补充要求</summary><label>这次要做什么<select value={draft.mode} onChange={e=>setDraft({...draft,mode:e.target.value})}><option value="goal">持续学习目标</option><option value="study">一次学习问题</option><option value="work">整理工作材料</option><option value="manage">安排与复盘</option></select></label>{draft.mode==='goal'&&<><label>希望达到什么程度<textarea rows={2} maxLength={4000} value={draft.outcome} onChange={e=>setDraft({...draft,outcome:e.target.value})} placeholder="例如：能独立完成第一讲的练习，每天 20 分钟"/></label><SourcePicker sources={sources.data||[]} value={draft.sourceIds} onChange={sourceIds=>setDraft({...draft,sourceIds})}/></>}</details>
      <div className={s.composerFooter}><span className={s.muted}>{draft.mode==='goal'?'每次只准备下一步。':'保留结果，随时继续。'}</span><button className={s.primary} disabled={action.busy||!draft.title.trim()||(draft.mode==='goal'&&draft.sourceIds.length>100)}>{action.busy?'正在创建…':'开始'}</button></div>
    </form><ErrorNotice error={action.error}/>
    <QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>
    {query.data&&<>{(!query.data.modelConfigured||!query.data.workerOnline)&&<div className={s.notice}>{!query.data.modelConfigured?<p>连接模型后，助手就能准备学习内容。<a href="#/settings">设置模型</a></p>:<p>后台尚未运行。已保存的任务会在后台启动后继续。</p>}</div>}<section className={s.section}><h2>接着做</h2><SessionRows sessions={query.data.sessions} empty="现在没有待处理的学习步骤。添加一个目标，助手会为你准备下一步。"/></section>{Boolean(query.data.goals.length)&&<a className={s.textLink} href="#/goals">查看全部目标（{query.data.goals.length}）</a>}</>}
  </>;
}
export function GoalsPage(){const query=useData<Goal[]>('/goals');return <><Heading title="目标" action={<a className={s.primary} href="#/today">添加目标</a>}>把想学的事，变成可以完成的一步。</Heading><QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>{query.data?.length?<div className={s.rows}>{query.data.map(goal=><a className={s.row} key={goal.id} href={'#/goal/'+encodeURIComponent(goal.id)}><div><strong>{goal.title}</strong><p>{goal.outcome||'每次准备一个学习步骤'}{goal.nextReview&&goal.status==='active'&&<> · 下次复习 {date(goal.nextReview)}</>}</p></div><Status state={goal.status==='completed'?'goal_completed':goal.status}/></a>)}</div>:query.data&&<p className={s.empty}>还没有目标。从一个想弄懂的问题开始。</p>}</>;}
export function GoalPage({id}:{id:string}){const query=useData<GoalDetail>('/goals/'+encodeURIComponent(id));return <><a className={s.back} href="#/goals">‹ 全部目标</a><QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>{query.data&&<GoalContent detail={query.data} reload={async()=>{const result=await query.refetch();return result.data?.goal;}}/>}</>;}
function GoalContent({detail,reload}:{detail:GoalDetail;reload:()=>Promise<Goal|undefined>}){
  const {goal,plan,sessions,attempts}=detail,api=useApi(),client=useQueryClient(),action=useAction(),sources=useData<SourceSummary[]>('/sources');
  const [edit,setEdit]=useState(false),[draft,setDraft]=useDraft('goal.'+goal.id,{title:goal.title,outcome:goal.outcome,sourceIds:goal.sourceIds,days:goal.intervals.map(n=>n/86400).join(', '),revision:goal.revision});
  const [markComplete,setMarkComplete]=useState(false);
  const refresh=()=>{void client.invalidateQueries();};
  const changeStatus=(status:Goal['status'])=>void action.run(()=>api.write('/goals/'+goal.id,UpdateGoal.parse({revision:goal.revision,status}),'PATCH'),()=>{setMarkComplete(false);refresh();});
  const save=(e:FormEvent)=>{e.preventDefault();void action.run(()=>{const intervals=draft.days.split(/[,，\s]+/).filter(Boolean).map(day=>Number(day)*86400);return api.write<{revision:number}>('/goals/'+goal.id,UpdateGoal.parse({revision:draft.revision,title:draft.title,outcome:draft.outcome,sourceIds:draft.sourceIds,intervals}),'PATCH');},result=>{setDraft(current=>({...current,revision:result.revision}));setEdit(false);refresh();});};
  const loadVersion=()=>void action.run(reload,current=>{if(current){setDraft(d=>({...d,revision:current.revision}));action.setMessage('已载入最新版本，保留了你的输入。');}});
  return <><Heading title={goal.title}><Status state={goal.status==='completed'?'goal_completed':goal.status}/>{goal.nextReview&&goal.status==='active'&&<> · 下次复习 {date(goal.nextReview)}</>}</Heading>{goal.outcome&&<p className={s.description}>{goal.outcome}</p>}<div className={s.toolbar}><button className={s.secondary} disabled={action.busy} onClick={()=>changeStatus(goal.status==='active'?'paused':'active')}>{goal.status==='active'?'暂停':'继续学习'}</button><button className={s.textButton} onClick={()=>setEdit(!edit)}>调整目标</button>{goal.status!=='completed'&&<button className={s.textButton} onClick={()=>setMarkComplete(!markComplete)}>标记完成</button>}</div>
    {markComplete&&<div className={s.notice}><p>完成目标由你确认。已准备材料和模型评估不会自动算作学完。</p><button className={s.primary} disabled={action.busy} onClick={()=>changeStatus('completed')}>我已完成这个目标</button><button className={s.textButton} onClick={()=>setMarkComplete(false)}>返回</button></div>}
    {edit&&<form className={s.form} onSubmit={save}><label>目标<input maxLength={200} required value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label><label>预期成果<textarea value={draft.outcome} maxLength={4000} onChange={e=>setDraft({...draft,outcome:e.target.value})}/></label><label>复习间隔（天，用逗号分隔）<input value={draft.days} onChange={e=>setDraft({...draft,days:e.target.value})}/></label><SourcePicker sources={sources.data||[]} value={draft.sourceIds} onChange={sourceIds=>setDraft({...draft,sourceIds})}/><button className={s.primary} disabled={action.busy||draft.sourceIds.length>100}>保存调整</button></form>}
    <ErrorNotice error={action.error} onReload={loadVersion}/>{action.message&&<p role="status" className={s.muted}>{action.message}</p>}
    {plan&&<section className={s.section}><h2>学习路径</h2><ol className={s.steps}>{plan.steps.map(step=><li key={step.id}><div><strong>{step.title}</strong><p>{step.objective}</p></div><Status state={step.state}/></li>)}</ol>{plan.rationale&&<details className={s.disclosure}><summary>为什么这样安排</summary><p>{plan.rationale}</p><p className={s.muted}>第 {plan.version} 版计划</p></details>}</section>}
    <section className={s.section}><h2>学习记录</h2><SessionRows sessions={sessions}/></section>{Boolean(attempts.length)&&<details className={s.disclosure}><summary>练习与反馈（{attempts.length}）</summary>{attempts.map(attempt=><div className={s.evidence} key={attempt.id}><p>{attempt.answer}</p><p>{attempt.feedback||(attempt.source==='ungraded'?'未评阅':'等待评估')}</p><span className={s.muted}>{attemptSource[attempt.source]} · {date(attempt.createdAt)}</span>{attempt.evidence&&<blockquote>{attempt.evidence}</blockquote>}</div>)}</details>}
  </>;
}
export function SessionPage({id}:{id:string}){const query=useData<SessionDetail>('/sessions/'+encodeURIComponent(id));return <><a className={s.back} href={query.data?.session.goalId?'#/goal/'+query.data.session.goalId:'#/today'}>‹ {query.data?.session.goalId?'返回目标':'今天'}</a><QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>{query.data&&<SessionContent detail={query.data} reload={async()=>{const result=await query.refetch();return result.data;}}/>}</>;}
function SessionContent({detail,reload}:{detail:SessionDetail;reload:()=>Promise<SessionDetail|undefined>}){
  const {session,attempts,artifacts,approvals}=detail,api=useApi(),client=useQueryClient(),action=useAction();
  const [answer,setAnswer]=useDraft('answer.'+session.id,{text:'',revision:session.revision,selfReport:''});
  const [editing,setEditing]=useState(false),[draft,setDraft]=useDraft('session.'+session.id,{content:session.content,recipient:(session as LearningSession&{recipient?:string}).recipient||'',revision:session.revision});
  const [archive,setArchive]=useState(false),[resolution,setResolution]=useState(''),[ownVersion,setOwnVersion]=useState(session.revision);
  const draftRef=useRef(draft);draftRef.current=draft;
  useEffect(()=>{if(!answer.text&&answer.revision!==session.revision)setAnswer(current=>({...current,revision:session.revision}));},[session.revision,answer.text]);
  useEffect(()=>{if(!editing && draft.content===session.content&&draft.revision!==session.revision)setDraft(current=>({...current,revision:session.revision}));},[session.revision,editing,session.content]);
  const refresh=()=>{void client.invalidateQueries();};
  const active=['queued','running'].includes(session.state),canAnswer=['waiting_feedback','ready','completed'].includes(session.state);
  const sending=approvals.some(approval=>['approved','executing','uncertain'].includes(approval.state));
  const submit=(e:FormEvent)=>{e.preventDefault();const sent=answer;void action.run(()=>api.write<{revision:number}>('/sessions/'+session.id+'/feedback',Feedback.parse({revision:answer.revision,answer:answer.text,...(answer.selfReport?{selfReport:answer.selfReport}:{})})),result=>{setAnswer(current=>({...current,text:current.text===sent.text?'':current.text,selfReport:current.text===sent.text?'':current.selfReport,revision:result.revision}));setOwnVersion(result.revision);refresh();});};
  const loadVersion=()=>void action.run(reload,result=>{if(result){setAnswer(current=>({...current,revision:result.session.revision}));setDraft(current=>({...current,revision:result.session.revision}));setOwnVersion(result.session.revision);action.setMessage('最新版本已载入，输入已保留。请核对后重新保存。');}});
  const save=(e:FormEvent)=>{e.preventDefault();const sent=draft;void action.run(()=>api.write<{revision:number}>('/sessions/'+session.id+'/draft',DraftInput.parse(draft),'PATCH'),result=>{setDraft(current=>({...current,revision:result.revision}));setOwnVersion(result.revision);if(draftRef.current.content===sent.content&&draftRef.current.recipient===sent.recipient)setEditing(false);action.setMessage('已保存。');refresh();});};
  const download=()=>void action.run(()=>api.request<string>('/sessions/'+session.id+'/export',{raw:true}),content=>{const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'})),anchor=document.createElement('a');anchor.href=url;anchor.download=(session.title||'学习记录').replace(/[\\/:*?"<>|]/g,'_')+'.md';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  const edit=()=>{if(draft.content!==session.content&&draft.revision<session.revision&&draft.revision===ownVersion)setDraft({content:session.content,recipient:(session as LearningSession&{recipient?:string}).recipient||'',revision:session.revision});setEditing(true);};
  return <><Heading title={session.title}><Status state={session.state}/></Heading><details className={s.disclosure}><summary>最初的要求</summary><p className={s.prewrap}>{session.prompt}</p></details>
    {session.error&&<div className={s.error} role="alert">{session.error}</div>}{active&&<div className={s.notice} role="status"><p>正在准备。你可以离开页面，稍后回来继续。</p><button className={s.secondary} disabled={action.busy||!session.currentRunId} onClick={()=>void action.run(()=>api.write('/runs/'+session.currentRunId+'/cancel'),refresh)}>停止</button></div>}
    {session.content&&<article className={s.answer}><Result>{session.content}</Result><Sources citations={session.citations}/></article>}
    {attempts.map(attempt=><section className={s.conversation} key={attempt.id}><div className={s.userAnswer}><span className={s.muted}>你的回答</span><p className={s.prewrap}>{attempt.answer}</p></div>{attempt.feedback&&<Result>{attempt.feedback}</Result>}<p className={s.muted}>{attempt.source==='ungraded'?'未评阅':`${attempt.verdict==='pass'?'本次练习已通过':attempt.verdict==='retry'?'再练一次':attempt.verdict==='pending'?'等待评阅':'还需要一点信息'} · ${attemptSource[attempt.source]}`}</p>{attempt.feedback&&attempt.evidence&&<details className={s.disclosure}><summary>评估依据</summary><p className={s.prewrap}>{attempt.evidence}</p></details>}</section>)}
    {canAnswer&&<form className={s.composer} onSubmit={submit}><label htmlFor="answer" className={s.composerLabel}>{session.goalId?'说说你的理解':'继续补充'}</label><textarea id="answer" rows={4} maxLength={30000} value={answer.text} onChange={e=>setAnswer({...answer,text:e.target.value})} placeholder="写下答案，也可以告诉我哪里还不清楚。"/>{session.kind==='study'&&<details className={s.composerOptions}><summary>补充自评</summary><label>我对这一步的理解<select value={answer.selfReport||''} onChange={e=>setAnswer({...answer,selfReport:e.target.value})}><option value="">请助手评阅</option><option value="understood">我已理解</option><option value="need_practice">还需要练习</option></select></label><p className={s.muted}>自评会作为本人的学习证据保留。</p></details>}<div className={s.composerFooter}><span className={s.muted}>输入会暂存于这个浏览器会话。</span><button className={s.primary} disabled={action.busy||!answer.text.trim()}>{action.busy?'正在提交…':'继续'}</button></div></form>}
    <ErrorNotice error={action.error} onReload={loadVersion}/>{action.message&&<p role="status" className={s.muted}>{action.message}</p>}
    {['failed','cancelled'].includes(session.state)&&<button className={s.primary} disabled={action.busy} onClick={()=>void action.run(()=>api.write('/sessions/'+session.id+'/retry',{revision:session.revision}),refresh)}>重新准备</button>}
    {editing&&<form className={s.form} onSubmit={save}><label>修改内容<textarea rows={12} maxLength={100000} value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})}/></label><label>收件人（需要邮件时填写）<input type="email" maxLength={320} value={draft.recipient} onChange={e=>setDraft({...draft,recipient:e.target.value})}/></label><div className={s.toolbar}><button className={s.primary} disabled={action.busy}>保存内容</button><button type="button" className={s.textButton} onClick={()=>setEditing(false)}>稍后再改</button></div></form>}
    {!active&&<details className={s.disclosure}><summary>更多操作</summary><div className={s.toolbar}>{session.state!=='archived'&&<button className={s.secondary} disabled={sending} onClick={edit}>修改内容</button>}<button className={s.secondary} disabled={action.busy} onClick={download}>导出</button>{session.state!=='archived'&&<><button className={s.secondary} disabled={action.busy||sending} onClick={()=>void action.run(()=>api.write('/sessions/'+session.id+'/approval',{revision:session.revision}),refresh)}>核对邮件</button><button className={s.textButton} onClick={()=>setArchive(!archive)}>归档</button></>}</div>{archive&&<div className={s.notice}><p>归档后仍可在历史中查看，当前学习步骤将结束。</p><button className={s.secondary} disabled={action.busy} onClick={()=>void action.run(()=>api.write('/sessions/'+session.id+'/archive',{revision:session.revision}),()=>{setArchive(false);refresh();})}>确认归档</button></div>}{Boolean(artifacts.length)&&<details className={s.disclosure}><summary>内容版本（{artifacts.length}）</summary>{artifacts.map(artifact=><details key={artifact.id} className={s.disclosure}><summary>{artifact.provenance==='user_revision'?'本人修订':'生成内容'} · {date(artifact.createdAt)}</summary><Result>{artifact.content}</Result></details>)}</details>}{detail.legacy!==null&&<LegacyRecord record={detail.legacy} sessionId={session.id}/>}</details>}
    {Boolean(approvals.length)&&<section className={s.section}><h2>邮件记录</h2>{approvals.map(approval=><div className={s.approval} key={approval.id}><p>{({pending:'等待确认',approved:'等待发送',executing:'正在发送',sent:'已发送',rejected:'已取消',invalidated:'内容已变更',uncertain:'发送结果待核实',failed:'发送失败'} as Record<string,string>)[approval.state]||approval.state}</p><dl className={s.metadata}>{(['recipient','sender','subject','draft','revision'] as const).map(key=><div key={key}><dt>{{recipient:'收件人',sender:'发送账号',subject:'主题',draft:'正文',revision:'内容版本'}[key]}</dt><dd className={s.prewrap}>{String(approval.payload[key]??'')}</dd></div>)}</dl>{approval.error&&<p className={s.dangerText}>{approval.error}</p>}{approval.state==='pending'&&<div className={s.toolbar}><button className={s.primary} disabled={action.busy} onClick={()=>void action.run(()=>api.write('/approvals/'+approval.id+'/decision',{digest:approval.digest,approve:true}),refresh)}>确认发送这封邮件</button><button className={s.secondary} disabled={action.busy} onClick={()=>void action.run(()=>api.write('/approvals/'+approval.id+'/decision',{digest:approval.digest,approve:false}),refresh)}>取消发送</button></div>}{approval.state==='uncertain'&&<div className={s.form}><p>请先在邮箱核对，这里不会自动重发。</p><label>核实记录<textarea value={resolution} onChange={e=>setResolution(e.target.value)} maxLength={2000}/></label><div className={s.toolbar}><button className={s.secondary} disabled={action.busy||!resolution.trim()} onClick={()=>void action.run(()=>api.write('/approvals/'+approval.id+'/resolve',{sent:true,note:resolution}),refresh)}>确认已发送</button><button className={s.secondary} disabled={action.busy||!resolution.trim()} onClick={()=>void action.run(()=>api.write('/approvals/'+approval.id+'/resolve',{sent:false,note:resolution}),refresh)}>确认未发送</button></div></div>}</div>)}</section>}
  </>;
}
