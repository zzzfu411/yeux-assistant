import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { ModelAssessment } from '../packages/contracts/src/assessment.js';
import { guardAssessment } from '../packages/core/src/assessment.js';
type Case={id:string;course:string;kind:string;material:string;question:string;answer:string;expected:'pass'|'retry'|'unclear';proposed:'pass'|'retry'|'unclear';rubric:string;fault?:'fabricated_answer'|'no_anchors'|'wrong_version';exerciseComplete?:boolean};
const cases=JSON.parse(readFileSync(new URL('../quality/learning-cases.json',import.meta.url),'utf8')) as Case[];
describe('synthetic learning cases: offline guard contracts, not model accuracy',()=>{
  it('keeps five distinct authored scenarios for each course',()=>{
    expect(cases).toHaveLength(15);expect(new Set(cases.map(item=>item.id)).size).toBe(15);
    for(const course of ['GSE','数据库','软件工程'])expect(cases.filter(item=>item.course===course).map(item=>item.kind).sort()).toEqual(['correct','generic','no_source','partial','wrong']);
    expect(cases.every(item=>item.question&&item.answer&&item.rubric)).toBe(true);
  });
  for(const item of cases)it(item.id+' / '+item.course+' / '+item.kind,()=>{
    const citation={sourceId:item.id+'-source',version:1,start:0,end:item.material.length,quote:item.material,title:'自行编写的合成材料',digest:'synthetic'};
    const refs=item.material?[{...citation,version:item.fault==='wrong_version'?2:1}]:[];
    const proposed=ModelAssessment.parse({verdict:item.proposed,feedback:'合成夹具：'+item.rubric,evidence:item.rubric,
      answerQuotes:item.fault==='no_anchors'?[]:[item.fault==='fabricated_answer'?'用户回答中没有出现的明确验收条件':item.answer],
      citationRefs:item.fault==='no_anchors'?[]:refs});
    const result=guardAssessment(proposed,{answer:item.answer,exerciseComplete:item.exerciseComplete??true,providedCitations:item.material?[citation]:[]});
    expect(result.assessment.verdict).toBe(item.expected);
    if(item.proposed!==item.expected){expect(result.downgraded).toBe(true);expect(result.reasons.length).toBeGreaterThan(0);}
  });
});
