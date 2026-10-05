import type { Citation, SourceMetadata, SourceSummary } from '../../../packages/contracts/src/index';

export const unclassifiedCourse='unclassified';
export const sourceCourse=(source:SourceSummary)=>source.metadata?.course||unclassifiedCourse;
type BriefMetadata=Pick<SourceMetadata,'course'|'courseName'|'format'>;
export const courseName=(metadata?:BriefMetadata|null)=>metadata?.courseName||metadata?.course||'未分类';
export const sourceFormat=(metadata?:BriefMetadata|null)=>({md:'Markdown',markdown:'Markdown',txt:'文本',text:'文本',html:'网页',pdf:'PDF',ppt:'PPT',pptx:'PPTX',doc:'Word',docx:'Word'} as Record<string,string>)[metadata?.format.toLowerCase()||'']||metadata?.format||'文本';
export const isExtracted=(metadata?:BriefMetadata|null)=>Boolean(metadata&&!['md','markdown','txt','text'].includes(metadata.format.toLowerCase()));
export function courses(sources:SourceSummary[]){
  const items=new Map<string,{id:string;name:string;count:number}>();
  for(const source of sources){const id=sourceCourse(source),prior=items.get(id);if(prior)prior.count++;else items.set(id,{id,name:courseName(source.metadata),count:1});}
  return [...items.values()].sort((a,b)=>a.id===unclassifiedCourse?1:b.id===unclassifiedCourse?-1:a.name.localeCompare(b.name,'zh-CN'));
}
export const matchesCourse=(source:SourceSummary,course:string)=>!course||sourceCourse(source)===course;
export const matchesCitationCourse=(citation:Citation,course:string)=>!course||(citation.course||unclassifiedCourse)===course;
