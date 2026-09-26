import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import type { Citation, LearningSession, SourceSummary } from '../../../packages/contracts/src/index';
import { ApiError } from './api';
import s from './styles.module.css';
import { courses, courseName, matchesCourse, sourceFormat } from './source-meta';
const Markdown=lazy(()=>import('react-markdown'));
export class PageBoundary extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className={s.error} role="alert"><p>页面未能载入。刷新后可以继续，输入草稿会保留。</p><button className={s.secondary} onClick={()=>window.location.reload()}>刷新页面</button></div>:this.props.children;}
}

export function navigate(path:string){window.location.hash=path;}
export const date=(value:string|null|undefined)=>value?new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
const states:Record<string,string>={queued:'等待开始',running:'准备中',waiting_feedback:'等你练习',ready:'已准备',completed:'已练习',goal_completed:'已完成',failed:'需要处理',cancelled:'已停止',archived:'已归档',active:'进行中',paused:'已暂停',practiced:'已练习',practicing:'当前这一步',pending:'待开始'};
export function Status({state}:{state:string}){return <span className={`${s.status} ${state==='failed'?s.dangerText:state==='waiting_feedback'?s.accentText:''}`}>{states[state]||state}</span>;}
export function Heading({title,children,action}:{title:string;children?:ReactNode;action?:ReactNode}){return <header className={s.heading}><div><h1>{title}</h1>{children&&<p className={s.muted}>{children}</p>}</div>{action}</header>;}
export function ErrorNotice({error,onReload}:{error:Error|null|undefined;onReload?:()=>void}){if(!error)return null;return <div className={s.error} role="alert"><p>{error.message}</p>{error instanceof ApiError&&error.status===409&&onReload&&<><p>当前输入仍在。载入最新版本后，你可以保留输入再保存。</p><button type="button" className={s.secondary} onClick={onReload}>载入最新版本，保留输入</button></>}</div>;}
export function QueryState({pending,error,retry}:{pending:boolean;error:Error|null;retry:()=>void}){if(pending)return <p className={s.muted} role="status">正在载入…</p>;if(error)return <div><ErrorNotice error={error}/><button className={s.secondary} onClick={retry}>重新载入</button></div>;return null;}
export function Result({children}:{children:string}){return <div className={s.prose}><Suspense fallback={<p className={s.muted}>正在载入内容…</p>}><Markdown components={{a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><span className={s.muted}>{alt?`[图片：${alt}]`:'[图片]'}</span>}}>{children}</Markdown></Suspense></div>;}
export function SessionRows({sessions,empty='还没有学习记录。'}:{sessions:LearningSession[];empty?:string}){return sessions.length?<div className={s.rows}>{sessions.map(session=><a className={s.row} href={'#/session/'+encodeURIComponent(session.id)} key={session.id}><div><strong>{session.title}</strong><p>{session.error||session.prompt.slice(0,90)}</p></div><Status state={session.state}/></a>)}</div>:<p className={s.empty}>{empty}</p>;}
export function CourseSelect({sources,value,onChange,label,allLabel='全部课程'}:{sources:SourceSummary[];value:string;onChange:(course:string)=>void;label:string;allLabel?:string}){
  const options=courses(sources);return <label>{label}<select value={value} onChange={event=>onChange(event.target.value)}><option value="">{allLabel}</option>{options.map(course=><option key={course.id} value={course.id}>{course.name}（{course.count}）</option>)}{value&&!options.some(option=>option.id===value)&&<option value={value}>{value}（暂无资料）</option>}</select></label>;
}
export function SourcePicker({sources,value,onChange}:{sources:SourceSummary[];value:string[];onChange:(ids:string[])=>void}){
  const [course,setCourse]=useState('');
  const visible=sources.filter(source=>matchesCourse(source,course));
  const selected=sources.filter(source=>value.includes(source.id));
  const outside=selected.filter(source=>!matchesCourse(source,course));
  const choose=(next:string)=>{setCourse(next);if(next)onChange(sources.filter(source=>matchesCourse(source,next)).map(source=>source.id));};
  return <fieldset className={s.fieldset}><legend>使用哪些资料</legend>{sources.length?<>
    <CourseSelect sources={sources} value={course} onChange={choose} label="关联课程" allLabel="全部资料（自行选择）"/>
    <p className={s.muted}>{value.length?<>已关联 {value.length} 份资料。{course?'可逐份取消。':'切回全部不会新增关联。'}</>:'未关联资料，可在下方选择。'}</p>
    {value.length>100&&<p className={s.error} role="alert">已关联 {value.length} 份资料，单个目标最多关联 100 份。请取消部分资料后再保存。</p>}
    {outside.length>0&&<p className={s.muted}>另有 {outside.length} 份其他课程资料已关联。</p>}
    <div className={s.sourceChoices}>{visible.map(source=><label className={s.check} key={source.id}><input type="checkbox" aria-label={source.title} checked={value.includes(source.id)} onChange={event=>onChange(event.target.checked?[...new Set([...value,source.id])]:value.filter(id=>id!==source.id))}/><span>{source.title}<small className={s.sourceMeta}>{courseName(source.metadata)} · {sourceFormat(source.metadata)}</small></span></label>)}</div>
  </>:<p className={s.muted}>可先到「资料」添加学习材料。</p>}</fieldset>;
}
export function Sources({citations}:{citations:Citation[]}){if(!citations.length)return null;return <details className={s.disclosure}><summary>参考资料 · {citations.length}</summary>{citations.map((citation,i)=><div className={s.citation} key={citation.sourceId+':'+i}><a href={'#/source/'+encodeURIComponent(citation.sourceId)+'?version='+citation.version}>{citation.title}</a><span className={s.muted}>{citation.courseName||citation.course?`${citation.courseName||citation.course} · `:''}{citation.location?`${citation.location} · `:''}第 {citation.version} 版 · 字符 {citation.start+1}–{citation.end}</span><blockquote>{citation.quote}</blockquote></div>)}</details>;}
export function Pages({page,total,onChange}:{page:number;total:number;onChange:(page:number)=>void}){if(total<=30)return null;return <div className={s.toolbar}><button className={s.secondary} disabled={!page} onClick={()=>onChange(page-1)}>上一页</button><span className={s.muted}>{page+1} / {Math.ceil(total/30)}</span><button className={s.secondary} disabled={(page+1)*30>=total} onClick={()=>onChange(page+1)}>下一页</button></div>;}
