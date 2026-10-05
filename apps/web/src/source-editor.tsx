import { useRef,useState,type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SourceUpdateInput,type SourceDetail } from '../../../packages/contracts/src/index';
import { useAction,useApi,useDraft } from './api';
import { ErrorNotice } from './ui';
import s from './styles.module.css';

export function SourceEditor({source,done}:{source:SourceDetail;done:()=>void}){
  const api=useApi(),client=useQueryClient(),action=useAction(),[latest,setLatest]=useState<SourceDetail|null>(null);
  const [draft,setDraft,clear]=useDraft('source-edit.'+source.id,{revision:source.revision,title:source.title,content:source.content});
  const current=useRef(draft);current.current=draft;
  const save=(event:FormEvent)=>{event.preventDefault();const sent=draft;void action.run(()=>api.write<{revision:number}>('/sources/'+encodeURIComponent(source.id),SourceUpdateInput.parse({revision:sent.revision,title:sent.title,...(source.editableText?{content:sent.content}:{})}),'PATCH'),result=>{void client.invalidateQueries();if(JSON.stringify(current.current)===JSON.stringify(sent)){clear();done();}else{setDraft(value=>({...value,revision:result.revision}));action.setMessage('已保存上次提交，继续输入的内容仍在。');}});};
  const reload=()=>void action.run(()=>api.get<SourceDetail>('/sources/'+encodeURIComponent(source.id)),setLatest);
  return <form className={s.form} onSubmit={save} aria-label="编辑资料">
    <label>资料标题<input required maxLength={200} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
    {source.editableText?<label>资料正文<textarea required rows={12} maxLength={2000000} value={draft.content} onChange={event=>setDraft({...draft,content:event.target.value})}/></label>:<p className={s.muted}>这里可修改标题。提取文本请通过原导入流程更新，保留原件与页码。</p>}
    <p className={s.muted}>保存后生成新版本，旧引用保留。已出题的评阅沿用原资料版本。</p>
    <ErrorNotice error={action.error} onReload={reload}/>
    {latest&&<div className={s.notice}><p>已读取最新的第 {latest.current_version} 版，你的输入仍保留。</p><details><summary>查看最新内容</summary><strong>{latest.title}</strong><pre className={s.raw}>{latest.content}</pre></details><div className={s.toolbar}><button type="button" className={s.secondary} onClick={()=>{setDraft({revision:latest.revision,title:latest.title,content:latest.content});setLatest(null);}}>使用最新内容</button><button type="button" className={s.textButton} onClick={()=>{setDraft(value=>({...value,revision:latest.revision}));setLatest(null);action.setMessage('已保留输入，保存时将替换当前版本。');}}>保留输入继续编辑</button></div></div>}
    {action.message&&<p role="status" className={s.muted}>{action.message}</p>}
    <div className={s.toolbar}><button className={s.primary} disabled={action.busy||Boolean(latest)||!draft.title.trim()||!draft.content.trim()}>保存新版本</button><button type="button" className={s.textButton} onClick={done}>关闭编辑</button></div>
  </form>;
}
