import { describe,expect,it } from 'vitest';
import { ModelAssessment } from '../packages/contracts/src/assessment.js';
import { guardAssessment } from '../packages/core/src/assessment.js';

const quote='事务😀要么全部生效，要么全部不生效。';
const source={sourceId:'synthetic-source',version:2,start:10,end:10+quote.length,quote,title:'合成讲义',digest:'synthetic'};
const answer='我认为事务要么全部生效，要么全部不生效。';
const proposal=()=>ModelAssessment.parse({verdict:'pass',feedback:'回答描述了全部成功或全部失败。',evidence:'回答中的要么全部生效对应资料定义。',answerQuotes:['要么全部生效'],citationRefs:[source]});
const input={answer,exerciseComplete:true,providedCitations:[source]};
describe('traceable assessment guard',()=>{
  it('accepts a supported verdict and a correctly positioned UTF-16 subquote',()=>{
    const proposed=proposal(),start=source.start+source.quote.indexOf('😀');proposed.citationRefs=[{...source,start,end:start+2,quote:'😀'}];
    expect(guardAssessment(proposed,input)).toMatchObject({downgraded:false,reasons:[],assessment:{verdict:'pass'}});
  });
  it.each((['pass','retry'] as const).flatMap(verdict=>(['answer','version','range','quote','empty'] as const).map(kind=>({verdict,kind}))))('downgrades $verdict with invalid $kind evidence and retains the proposal unchanged',({verdict,kind})=>{
    const proposed={...proposal(),verdict};
    if(kind==='answer')proposed.answerQuotes=['用户从未说过的完整推理'];
    if(kind==='version')proposed.citationRefs[0]!.version=1;
    if(kind==='range')proposed.citationRefs[0]!.start=9;
    if(kind==='quote')proposed.citationRefs[0]!.quote='资料中不存在的定义';
    if(kind==='empty')proposed.answerQuotes=['   '];
    const original=structuredClone(proposed),result=guardAssessment(proposed,input);
    expect(result.assessment.verdict).toBe('unclear');expect(result.downgraded).toBe(true);expect(result.reasons.length).toBeGreaterThan(0);expect(proposed).toEqual(original);
  });
  it('does not treat valid legacy JSON as sufficient evidence',()=>{
    const result=guardAssessment(ModelAssessment.parse({verdict:'pass',feedback:'正确',evidence:'回答正确'}),input);
    expect(result.reasons).toEqual(['missing_answer_quote','missing_citation']);expect(result.assessment.verdict).toBe('unclear');
  });
  it.each((['pass','retry'] as const).flatMap(verdict=>[false,true].map(complete=>({verdict,complete}))))('does not accept $verdict without the complete question or actually supplied sources (complete=$complete)',({verdict,complete})=>{
    const result=guardAssessment({...proposal(),verdict},{...input,exerciseComplete:complete,providedCitations:complete?[]:[source]});
    expect(result.assessment.verdict).toBe('unclear');expect(result.reasons).toContain(complete?'missing_sources':'missing_exercise');
  });
  it('rejects a claim of mastery when a provider invents evidence for a pure self-report',()=>{
    const proposed={...proposal(),answerQuotes:['给出完整证明并覆盖所有条件']};
    const result=guardAssessment(proposed,{...input,answer:'已经理解了。'});
    expect(result.assessment.verdict).toBe('unclear');expect(result.reasons).toContain('invalid_answer_quote');
    expect(result.assessment.answerQuotes).toEqual([]);
  });
  it('does not let a convincing answer or a remembered source replace actually provided material',()=>{
    const result=guardAssessment(proposal(),{...input,providedCitations:[]});
    expect(result.assessment.verdict).toBe('unclear');expect(result.reasons).toEqual(['missing_sources','invalid_citation']);
    expect(result.assessment.citationRefs).toEqual([]);
  });
  it('keeps supported retries and unclear judgments without presenting evidence checks as semantic grading',()=>{
    const retry={...proposal(),verdict:'retry' as const};expect(guardAssessment(retry,input).assessment).toEqual(retry);
    const unclear=ModelAssessment.parse({verdict:'unclear',feedback:'请补充具体例子。',evidence:''});expect(guardAssessment(unclear,input).assessment).toEqual(unclear);
    // Even exact quotes can be semantically irrelevant. This guard does not
    // pretend to decide whether a model's reasoning is educationally correct.
    const proposed={...proposal(),answerQuotes:['我不知道']};
    expect(guardAssessment(proposed,{...input,answer:'我不知道'}).downgraded).toBe(false);
  });
});
