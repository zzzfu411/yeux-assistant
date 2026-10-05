import { Component, lazy, Suspense, useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Citation, LearningSession, SourceSummary } from '../../../packages/contracts/src/index';
import type { CursorPage,SessionSummary } from '../../../packages/contracts/src/pagination';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError,useData } from './api';
import s from './styles.module.css';
import { Icon } from './icons';
import { courses, courseName, matchesCourse, sourceFormat } from './source-meta';
const Markdown=lazy(()=>import('react-markdown'));
export class PageBoundary extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<div className={s.error} role="alert"><p>页面未能载入。刷新后可以继续，输入草稿会保留。</p><button type="button" className={s.secondary} onClick={()=>window.location.reload()}>刷新页面</button></div>:this.props.children;}
}

export function navigate(path:string){window.location.hash=path;}
export const date=(value:string|null|undefined)=>value?new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)):'';
const states:Record<string,string>={queued:'等待开始',running:'准备中',waiting_feedback:'等你练习',ready:'已准备',completed:'已练习',goal_completed:'已完成',failed:'需要处理',cancelled:'已停止',archived:'已归档',active:'进行中',paused:'已暂停',practiced:'已练习',practicing:'当前这一步',pending:'待开始'};
export function Status({state}:{state:string}){return <span className={`${s.status} ${state==='failed'?s.dangerText:state==='waiting_feedback'?s.accentText:''}`}>{states[state]||state}</span>;}
export function Heading({title,children,action}:{title:string;children?:ReactNode;action?:ReactNode}){return <header className={s.heading}><div><h1>{title}</h1>{children&&<p className={s.muted}>{children}</p>}</div>{action}</header>;}
export function ErrorNotice({error,onReload}:{error:Error|null|undefined;onReload?:()=>void}){if(!error)return null;return <div className={s.error} role="alert"><p>{error.message}</p>{error instanceof ApiError&&error.status===409&&onReload&&<><p>当前输入仍在。载入最新版本后，你可以保留输入再保存。</p><button type="button" className={s.secondary} onClick={onReload}>载入最新版本，保留输入</button></>}</div>;}
export function QueryState({pending,error,retry}:{pending:boolean;error:Error|null;retry:()=>void}){if(pending)return <p className={s.muted} role="status">正在载入…</p>;if(error)return <div><ErrorNotice error={error}/><button type="button" className={s.secondary} onClick={retry}>重新载入</button></div>;return null;}
export function Result({children}:{children:string}){return <div className={s.prose}><Suspense fallback={<p className={s.muted}>正在载入内容…</p>}><Markdown components={{a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><span className={s.muted}>{alt?`[图片：${alt}]`:'[图片]'}</span>}}>{children}</Markdown></Suspense></div>;}
export function SessionRows({sessions,empty='还没有学习记录。',showAction=false}:{sessions:Array<LearningSession|SessionSummary>;empty?:string;showAction?:boolean}){
  return sessions.length?<div className={s.rows}>{sessions.map(session=>{
    const action=session.state==='waiting_feedback'?(session.kind==='study'?'继续练习':'查看并反馈'):['queued','running'].includes(session.state)?'查看进度':session.state==='failed'?'处理任务':'查看记录';
    const preview='promptPreview' in session?session.errorPreview||session.promptPreview:session.error||session.prompt.slice(0,90);
    return <a className={s.row} href={'#/session/'+encodeURIComponent(session.id)} key={session.id}><div><strong>{session.title}</strong><p>{preview}</p></div>{showAction?<div className={s.rowActions}><Status state={session.state}/><span className={s.rowAction}>{action}<Icon name="arrow"/></span></div>:<Status state={session.state}/>}</a>;
  })}</div>:<p className={s.empty}>{empty}</p>;
}
export function CourseSelect({sources,value,onChange,label,allLabel='全部课程'}:{sources:SourceSummary[];value:string;onChange:(course:string)=>void;label:string;allLabel?:string}){
  const options=courses(sources);return <label>{label}<select value={value} onChange={event=>onChange(event.target.value)}><option value="">{allLabel}</option>{options.map(course=><option key={course.id} value={course.id}>{course.name}（{course.count}）</option>)}{value&&!options.some(option=>option.id===value)&&<option value={value}>{value}（暂无资料）</option>}</select></label>;
}
export function SourceCatalogPages({page,total,onChange,label}:{page:number;total:number;onChange:(page:number)=>void;label:string}){
  const pages=Math.max(1,Math.ceil(total/30));
  return <div className={s.catalogPages} role="group" aria-label={label}><span className={s.muted} role="status">共 {total} 份{pages>1?` · 第 ${page+1} / ${pages} 页`:''}</span>{pages>1&&<div className={s.toolbar}><button type="button" className={s.secondary} disabled={page===0} onClick={()=>onChange(page-1)}>上一页</button><button type="button" className={s.secondary} disabled={page+1>=pages} onClick={()=>onChange(page+1)}>下一页</button></div>}</div>;
}
export function SourcePicker({sources,value,onChange,selectionReady=false,onRefresh,refreshing=false}:{sources:SourceSummary[];value:string[];onChange:(ids:string[])=>void;selectionReady?:boolean;onRefresh?:()=>void;refreshing?:boolean}){
  const [course,setCourse]=useState(''),[search,setSearch]=useState(''),[onlySelected,setOnlySelected]=useState(false),[page,setPage]=useState(0),[error,setError]=useState('');
  const deferredSearch=useDeferredValue(search.trim().toLocaleLowerCase());
  const available=useMemo(()=>new Set(sources.map(source=>source.id)),[sources]);
  const selected=useMemo(()=>new Set(value),[value]);
  const unavailable=selectionReady?value.filter(id=>!available.has(id)):[];
  const visible=useMemo(()=>sources.filter(source=>matchesCourse(source,course)&&(!onlySelected||selected.has(source.id))&&(!deferredSearch||source.title.toLocaleLowerCase().includes(deferredSearch))),[sources,course,onlySelected,selected,deferredSearch]);
  const currentPage=Math.min(page,Math.max(0,Math.ceil(visible.length/30)-1)),current=visible.slice(currentPage*30,currentPage*30+30);
  const newIds=current.filter(source=>!selected.has(source.id)).map(source=>source.id);
  useEffect(()=>{setPage(currentPage);},[currentPage]);
  const add=(ids:string[])=>{const next=[...new Set([...value,...ids])];if(next.length>100){setError(`本次关联后将有 ${next.length} 份资料，最多关联 100 份。已有关联未改变，请逐份选择或先移除部分资料。`);return;}setError('');onChange(next);};
  const remove=(id:string)=>{setError('');onChange(value.filter(item=>item!==id));};
  return <fieldset className={s.fieldset}><legend>关联资料</legend>
    <div className={s.catalogSummary}><p className={s.muted} role="status">{value.length?`已关联 ${value.length} 份资料。`:'未关联资料，可在下方选择。'}</p>{onRefresh&&<button type="button" className={s.textButton} disabled={refreshing} onClick={onRefresh}>{refreshing?'正在刷新…':'刷新资料'}</button>}</div>
    {unavailable.length>0&&<div className={s.notice} role="status"><p>有 {unavailable.length} 份关联资料已归档或不可用。原关联仍保留。</p><button type="button" className={s.textButton} onClick={()=>{setError('');onChange(value.filter(id=>available.has(id)));}}>移除不可用关联</button></div>}
    {value.length>100&&<p className={s.error} role="alert">已关联 {value.length} 份资料，单个目标最多关联 100 份。请取消部分资料后再保存。</p>}
    {sources.length?<>
      <div className={s.catalogFilters}><CourseSelect sources={sources} value={course} onChange={next=>{setCourse(next);setPage(0);}} label="筛选课程"/><label>按标题筛选<input type="search" value={search} maxLength={200} onChange={event=>{setSearch(event.target.value);setPage(0);}} placeholder="输入资料标题"/></label></div>
      <div className={s.catalogSummary}><button type="button" className={s.textButton} aria-pressed={onlySelected} onClick={()=>{setOnlySelected(!onlySelected);setPage(0);}}>{onlySelected?'显示全部资料':'只看已关联'}</button><button type="button" className={s.secondary} disabled={!newIds.length||!selectionReady} onClick={()=>add(newIds)}>关联本页</button></div>
      {error&&<p className={s.error} role="alert">{error}</p>}
      {visible.length?<div className={s.sourceChoices}>{current.map(source=><label className={s.check} key={source.id}><input type="checkbox" aria-label={source.title} checked={selected.has(source.id)} onChange={event=>event.target.checked?add([source.id]):remove(source.id)}/><span>{source.title}<small className={s.sourceMeta}>{courseName(source.metadata)} · {sourceFormat(source.metadata)}</small></span></label>)}</div>:<p className={s.muted}>{onlySelected?'当前筛选下没有已关联资料。':'没有符合条件的资料。'}</p>}
      <SourceCatalogPages page={currentPage} total={visible.length} onChange={setPage} label="资料选择分页"/>
    </>:<p className={s.muted}>可先到「资料」添加学习材料。</p>}
  </fieldset>;
}
export function Sources({citations}:{citations:Citation[]}){if(!citations.length)return null;return <details className={s.disclosure}><summary>参考资料 · {citations.length}</summary>{citations.map((citation,i)=><div className={s.citation} key={citation.sourceId+':'+i}><a href={'#/source/'+encodeURIComponent(citation.sourceId)+'?version='+citation.version}>{citation.title}</a><span className={s.muted}>{citation.courseName||citation.course?`${citation.courseName||citation.course} · `:''}{citation.location?`${citation.location} · `:''}第 {citation.version} 版 · 字符 {citation.start+1}–{citation.end}</span><blockquote>{citation.quote}</blockquote></div>)}</details>;}
export function Pages({page,total,onChange}:{page:number;total:number;onChange:(page:number)=>void}){if(total<=30)return null;return <div className={s.toolbar}><button type="button" className={s.secondary} disabled={!page} onClick={()=>onChange(page-1)}>上一页</button><span className={s.muted}>{page+1} / {Math.ceil(total/30)}</span><button type="button" className={s.secondary} disabled={(page+1)*30>=total} onClick={()=>onChange(page+1)}>下一页</button></div>;}

export function useCursorList<T>(base:string){
  const client=useQueryClient(),[position,setPosition]=useState({base,cursor:'',previous:[] as string[]});
  useEffect(()=>setPosition({base,cursor:'',previous:[]}),[base]);
  const current=position.base===base?position:{base,cursor:'',previous:[] as string[]};
  const first=base+(base.includes('?')?'&':'?')+'limit=30',path=first+(current.cursor?'&cursor='+encodeURIComponent(current.cursor):'');
  const query=useData<CursorPage<T>>(path);
  return {query,page:current.previous.length,
    next:()=>{if(query.data?.nextCursor)setPosition({base,cursor:query.data.nextCursor,previous:[...current.previous,query.data.pageCursor]});},
    previous:()=>{if(current.previous.length)setPosition({base,cursor:current.previous.at(-1)!,previous:current.previous.slice(0,-1)});},
    refresh:()=>{setPosition({base,cursor:'',previous:[]});void client.invalidateQueries({queryKey:[first],exact:true});}};
}
export function CursorControls({list}:{list:ReturnType<typeof useCursorList<any>>}){
  const {query,page}=list,multiple=page>0||Boolean(query.data?.nextCursor)||(query.data?.total??0)>30;return <div className={s.toolbar} aria-label="列表分页">{multiple&&<button type="button" className={s.secondary} disabled={!page||query.isFetching} onClick={list.previous}>上一页</button>}<span className={s.muted}>{multiple?`第 ${page+1} 页${query.data?` · 共 ${query.data.total} 条`:''}`:query.data?`共 ${query.data.total} 条`:'正在读取'}</span>{multiple&&<button type="button" className={s.secondary} disabled={!query.data?.nextCursor||query.isFetching} onClick={list.next}>下一页</button>}<button type="button" className={s.textButton} disabled={query.isFetching} onClick={list.refresh}>刷新列表</button></div>;
}
