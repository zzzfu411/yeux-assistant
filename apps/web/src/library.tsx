import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SourceInput, MemoryInput, type SourceSummary, type SourceMetadata, type Citation } from '../../../packages/contracts/src/index';
import { useAction, useApi, useData, useDraft } from './api';
import { date, ErrorNotice, Heading, navigate, QueryState, Result, CourseSelect } from './ui';
import { courseName, isExtracted, matchesCourse, matchesCitationCourse, sourceFormat } from './source-meta';
import s from './styles.module.css';

type Memory={key:string;scope:string;content:string;version:number;confirmed:boolean;enabled:boolean;updated_at:string};
const scopeNames:Record<string,string>={preference:'偏好',fact:'本人信息',correction:'纠正',all:'全部任务',study:'学习',work:'工作',manage:'管理'};
export function LibraryPage(){
  const query=useData<SourceSummary[]>('/sources'),api=useApi(),action=useAction(),client=useQueryClient();
  const [adding,setAdding]=useState(false),[tab,setTab]=useState<'sources'|'memories'>('sources');
  const [draft,setDraft]=useDraft('source',{title:'',content:''});const sourceDraft=useRef(draft);sourceDraft.current=draft;
  const [search,setSearch]=useState(''),[submitted,setSubmitted]=useState<string|null>(null),[course,setCourse]=useState('');
  const searchQuery=useQuery({queryKey:['/search',submitted,course],enabled:submitted!==null,queryFn:({signal})=>api.get<Citation[]>('/search?q='+encodeURIComponent(submitted||'')+(course?'&course='+encodeURIComponent(course):''),signal),retry:1});
  const visible=(query.data||[]).filter(source=>matchesCourse(source,course));
  const results=(searchQuery.data||[]).filter(hit=>matchesCitationCourse(hit,course));
  const submit=(event:FormEvent)=>{event.preventDefault();void action.run(()=>api.write<{id:string}>('/sources',SourceInput.parse(draft)),result=>{const unchanged=sourceDraft.current.title===draft.title&&sourceDraft.current.content===draft.content;if(unchanged){setDraft({title:'',content:''});setAdding(false);navigate('/source/'+result.id);}else action.setMessage('上一份内容已保存，保留了你继续输入的文字。');void client.invalidateQueries();});};
  const find=(event:FormEvent)=>{event.preventDefault();const value=search.trim();if(!value)return;if(value===submitted)void searchQuery.refetch();else setSubmitted(value);};
  const readFile=(file:File|undefined)=>{if(!file)return;void action.run(async()=>{if(!/\.(md|txt)$/i.test(file.name))throw new Error('请选择 Markdown 或文本文件。');if(file.size>2_000_000)throw new Error('文件超过 2 MB，请拆分后添加。');return new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());},content=>setDraft({title:file.name,content}));};
  return <>
    <Heading title="资料" action={tab==='sources'?<button className={s.primary} onClick={()=>setAdding(!adding)}>添加资料</button>:undefined}>原始材料和你的偏好，分开保存。</Heading>
    <div className={s.tabs} role="tablist" aria-label="资料分类"><button className={tab==='sources'?s.selectedTab:s.tab} role="tab" aria-selected={tab==='sources'} onClick={()=>setTab('sources')}>学习材料</button><button className={tab==='memories'?s.selectedTab:s.tab} role="tab" aria-selected={tab==='memories'} onClick={()=>setTab('memories')}>记忆与偏好</button></div>
    {tab==='memories'?<Memories/>:<>
      {adding&&<form className={s.form} onSubmit={submit}><label>选择文件<input type="file" accept=".md,.txt,text/markdown,text/plain" onChange={event=>readFile(event.target.files?.[0])}/></label><label>标题<input value={draft.title} maxLength={200} required onChange={event=>setDraft({...draft,title:event.target.value})}/></label><label>原文<textarea value={draft.content} rows={9} required maxLength={2000000} onChange={event=>setDraft({...draft,content:event.target.value})}/></label><p className={s.muted}>支持 Markdown 和文本，最多 2 MB。只添加你希望助手使用的材料。</p><button className={s.primary} disabled={action.busy||!draft.title.trim()||!draft.content}>{action.busy?'正在添加…':'保存资料'}</button></form>}
      <div className={s.libraryTools}><CourseSelect sources={query.data||[]} value={course} onChange={setCourse} label="筛选课程"/><form className={s.search} onSubmit={find}><label className={s.srOnly} htmlFor="search">查找资料</label><input id="search" type="search" value={search} maxLength={2000} onChange={event=>{setSearch(event.target.value);if(!event.target.value)setSubmitted(null);}} placeholder="查找关键词"/><button className={s.secondary} disabled={!search.trim()}>查找</button></form></div>
      <ErrorNotice error={action.error}/>{action.message&&<p role="status" className={s.muted}>{action.message}</p>}
      {submitted!==null?<section className={s.section}>
        <div className={s.sectionHeading}><h2>查找结果</h2><button className={s.textButton} onClick={()=>{setSubmitted(null);setSearch('');}}>返回资料列表</button></div>
        <QueryState pending={searchQuery.isPending} error={searchQuery.error} retry={()=>void searchQuery.refetch()}/>
        {results.map((hit,index)=><article className={s.searchResult} key={hit.sourceId+':'+index}><a href={'#/source/'+encodeURIComponent(hit.sourceId)+'?version='+hit.version}>{hit.title}</a><p>{hit.quote}</p><span className={s.muted}>{hit.courseName||hit.course||'未分类'} · {hit.location||`字符 ${hit.start+1}–${hit.end}`} · 第 {hit.version} 版</span></article>)}
        {!searchQuery.isPending&&!searchQuery.error&&!results.length&&<p className={s.empty}>没有找到。试试更短的关键词或其他课程。</p>}
      </section>:<>
        <QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>
        {visible.length?<div className={s.rows}>{visible.map(source=><a className={s.row} key={source.id} href={'#/source/'+encodeURIComponent(source.id)}><div><strong>{source.title}</strong><p>{courseName(source.metadata)} · {sourceFormat(source.metadata)} · 第 {source.version} 版</p><p>{date(source.updatedAt)}</p></div><span className={s.muted}>{isExtracted(source.metadata)?'提取文本':'原始资料'}</span></a>)}</div>:query.data&&<p className={s.empty}>{course?'这门课程还没有资料。':'添加一份讲义或笔记，学习回答就能引用你的材料。'}</p>}
      </>}
    </>}
  </>;
}

function SourceOrigin({metadata}:{metadata:SourceMetadata}){
  const numbers=[...new Set(metadata.pages.map(page=>page.number))].sort((a,b)=>a-b);
  const ranges:string[]=[];
  for(let index=0;index<numbers.length;index++){
    const first=numbers[index]!;let last=first;
    while(index+1<numbers.length&&numbers[index+1]===last+1){index++;last=numbers[index]!;}
    ranges.push(first===last?String(first):`${first}–${last}`);
  }
  return <details className={s.disclosure}><summary>来源与提取说明{metadata.warnings.length?`（${metadata.warnings.length} 项提示）`:''}</summary>
    <dl className={s.metadata}><div><dt>原文件</dt><dd className={s.prewrap}>{metadata.originPath}</dd></div><div><dt>来源格式</dt><dd>{sourceFormat(metadata)}</dd></div><div><dt>提取方式</dt><dd className={s.prewrap}>{metadata.extraction}</dd></div>{numbers.length>0&&<div><dt>{/^pptx?$/i.test(metadata.format)?'幻灯片':'页码'}</dt><dd>{ranges.join('、')}（沿用原文件页序）</dd></div>}</dl>
    {isExtracted(metadata)&&<p className={s.muted}>当前展示原文件的文字提取结果。图片、公式与版式请核对原文件。</p>}
    {metadata.warnings.length>0&&<ul className={s.sourceWarnings}>{metadata.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
  </details>;
}
export function SourcePage({id,version}:{id:string;version?:string}){
  const query=useData<{id:string;title:string;version:number;current_version:number;content:string;digest:string;metadata?:SourceMetadata|null}>('/sources/'+encodeURIComponent(id)+(version?'?version='+encodeURIComponent(version):''));
  const api=useApi(),action=useAction();
  const download=()=>{const source=query.data;if(!source?.metadata?.assetKey)return;void action.run(()=>api.downloadBlob('/sources/'+encodeURIComponent(id)+'/original?version='+source.version),blob=>{const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=source.metadata!.originPath.replace(/\\/g,'/').split('/').at(-1)||source.title;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});};
  return <><a className={s.back} href="#/library">‹ 全部资料</a><QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>{query.data&&<>
    <Heading title={query.data.title} action={query.data.metadata?.assetKey?<button className={s.secondary} disabled={action.busy} onClick={download}>{action.busy?'正在下载…':'下载原文件'}</button>:undefined}>{query.data.metadata&&<>{courseName(query.data.metadata)} · {sourceFormat(query.data.metadata)} · </>}{isExtracted(query.data.metadata)?'提取文本':'原始资料'} · 第 {query.data.version} 版{query.data.version!==query.data.current_version&&<> · <a href={'#/source/'+encodeURIComponent(id)}>查看最新版</a></>}</Heading>
    <ErrorNotice error={action.error}/>{query.data.metadata&&<SourceOrigin metadata={query.data.metadata}/>}<Result>{query.data.content}</Result><details className={s.disclosure}><summary>{isExtracted(query.data.metadata)?'提取文本原文':'原文'}</summary><pre className={s.raw}>{query.data.content}</pre></details>
  </>}</>;
}
function Memories(){const query=useData<Memory[]>('/memories'),[editing,setEditing]=useState<Memory|null|undefined>(undefined);return <><div className={s.sectionHeading}><p className={s.muted}>你可以修改或停用。未确认的信息会单独标明。</p><button className={s.secondary} onClick={()=>setEditing(null)}>添加偏好</button></div><QueryState pending={query.isPending} error={query.error} retry={()=>void query.refetch()}/>{editing!==undefined&&<MemoryEditor key={editing?.key||'new'} memory={editing} done={()=>setEditing(undefined)}/>}<div className={s.rows}>{query.data?.map(memory=><div className={s.row} key={memory.key}><div><strong>{scopeNames[memory.scope]||memory.scope}{!memory.enabled?' · 已停用':''}{!memory.confirmed?' · 待本人确认':''}</strong><p className={s.prewrap}>{memory.content}</p></div><button className={s.textButton} onClick={()=>setEditing(memory)}>修改</button></div>)}</div>{query.data?.length===0&&<p className={s.empty}>例如：每天学习 20 分钟，先提问，再给解释。</p>}</>;}
function MemoryEditor({memory,done}:{memory:Memory|null;done:()=>void}){
  const api=useApi(),client=useQueryClient(),action=useAction(),[history,setHistory]=useState<Array<{version:number;snapshot:Record<string,unknown>;created_at:string}>|null>(null);
  const [draft,setDraft,clear]=useDraft('memory.'+(memory?.key||'new'),{key:memory?.key||'preference-'+Date.now(),content:memory?.content||'',scope:memory?.scope||'preference',confirmed:memory?.confirmed??true,enabled:memory?.enabled??true,revision:memory?.version||0});
  const draftRef=useRef(draft);draftRef.current=draft;
  const save=(e:FormEvent)=>{e.preventDefault();const sent=draft;void action.run(()=>api.write<{version:number}>('/memories',MemoryInput.parse(sent)),result=>{void client.invalidateQueries();if(JSON.stringify(draftRef.current)===JSON.stringify(sent)){clear();done();}else{setDraft(current=>({...current,revision:result.version}));action.setMessage('已保存上次提交，继续编辑的内容仍在。');}});};
  const reload=()=>void action.run(()=>api.get<Memory[]>('/memories'),rows=>{const updated=rows.find(row=>row.key===draft.key);if(updated)setDraft(current=>({...current,revision:updated.version}));action.setMessage('已载入最新版本，输入已保留。');});
  return <form className={s.form} onSubmit={save}><label>内容<textarea rows={4} maxLength={30000} required value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})}/></label><label>用途<select value={draft.scope} onChange={e=>setDraft({...draft,scope:e.target.value})}>{Object.entries(scopeNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className={s.check}><input type="checkbox" checked={draft.confirmed} onChange={e=>setDraft({...draft,confirmed:e.target.checked})}/>这是我确认的信息</label><label className={s.check}><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>在后续学习中使用</label><ErrorNotice error={action.error} onReload={reload}/>{action.message&&<p className={s.muted} role="status">{action.message}</p>}<div className={s.toolbar}><button className={s.primary} disabled={action.busy||!draft.content.trim()}>保存偏好</button><button type="button" className={s.textButton} onClick={done}>关闭</button>{memory&&<button type="button" className={s.textButton} onClick={()=>void action.run(()=>api.get<Array<{version:number;snapshot:Record<string,unknown>;created_at:string}>>('/memories/'+encodeURIComponent(memory.key)+'/history'),setHistory)}>查看历史</button>}</div>{history&&<div>{history.map(item=><div className={s.evidence} key={item.version}><p>第 {item.version} 版 · {date(item.created_at)}</p><p className={s.prewrap}>{String(item.snapshot.content||'')}</p></div>)}</div>}</form>;
}
