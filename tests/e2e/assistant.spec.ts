import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Citation, SourceMetadata, SourceSummary } from '../../packages/contracts/src/index';

const timestamp='2026-09-19T02:00:00.000Z';
function fixture(){
  const goal={id:'goal-1',title:'理解软件工程的需求分析',outcome:'能写出可验证的验收标准',status:'active',revision:1,sourceIds:['source-1'],intervals:[86400,259200,604800],reviewStage:0,nextReview:null,createdAt:timestamp,updatedAt:timestamp};
  const session={id:'session-1',goalId:'goal-1',title:goal.title,kind:'study',prompt:'需求分析应该从哪里开始？',state:'waiting_feedback',revision:1,currentRunId:'run-1',content:'## 从使用者开始\n\n写出一个可验证的验收标准，再解释它解决了谁的问题。',citations:[{sourceId:'source-1',version:1,title:'第一讲：软件工程',start:0,end:16,quote:'需求从使用者的具体问题开始。',digest:'a'.repeat(64)}] as Citation[],error:'',recipient:'student@example.com',createdAt:timestamp,updatedAt:timestamp};
  return {goal,session,legacy:null as Record<string,unknown>|null,attempts:[] as Array<Record<string,unknown>>,posts:[] as Array<{path:string;body:Record<string,unknown>;key:string|undefined}>,abortCreate:false,delayCreate:0,delayDraft:0,conflictFeedback:false,events:[] as string[],searches:[] as string[],completedSearches:[] as string[],searchDelays:{} as Record<string,number>,originals:[] as string[],originalDelay:0,completedOriginals:[] as string[],sourceVersions:{} as Record<string,{metadata:SourceMetadata|null;content?:string}>,settings:{base_url:'https://model.example/v1',model:'test-model',has_api_key:false,tools:true,revision:'a'.repeat(64),mail_configured:true},approvals:[] as Array<Record<string,unknown>>,sources:[{id:'source-1',title:'第一讲：软件工程',version:1,digest:'a'.repeat(64),updatedAt:timestamp}] as SourceSummary[],memories:[{key:'legacy-preference',scope:'all',content:'每天学习 20 分钟',version:2,confirmed:true,enabled:true,updated_at:timestamp}],schedules:[] as Array<Record<string,unknown>>};
}
type State=ReturnType<typeof fixture>;
async function setup(page:Page,state=fixture(),login=true){
  await page.route('**/api/v2/**',async(route:Route)=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v2',''),method=request.method();
    const json=(data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(request.headers().authorization!=='Bearer test-token')return json({error:{code:'unauthorized',message:'请输入访问口令。'}},401);
    if(path==='/events'){state.events.push(url.searchParams.get('after')||'0');return route.fulfill({contentType:'text/event-stream',body:'id: 7\ndata: '+JSON.stringify({id:'7',kind:'session.updated',entityId:'session-1',data:{},createdAt:timestamp})+'\n\n: heartbeat\n\n'});}
    if(method!=='GET'){
      const body=request.postDataJSON()||{};state.posts.push({path,body,key:request.headers()['idempotency-key']});
      if(path==='/goals'){if(state.abortCreate){state.abortCreate=false;return route.abort('connectionreset');}if(state.delayCreate)await new Promise(resolve=>setTimeout(resolve,state.delayCreate));state.goal.title=body.title;state.session.title=body.title;return json({goalId:'goal-1',sessionId:'session-1',runId:'run-1'},202);}
      if(path==='/sessions/session-1/draft'){if(state.delayDraft)await new Promise(resolve=>setTimeout(resolve,state.delayDraft));state.session.content=body.content;state.session.revision=Number(body.revision)+1;return json({sessionId:'session-1',revision:state.session.revision});}
      if(path==='/sessions/session-1/feedback'){if(state.conflictFeedback){state.conflictFeedback=false;state.session.revision=2;return json({error:{code:'version_conflict',message:'内容已更新，请载入最新版本。'}},409);}state.session.state='queued';state.session.revision=Number(body.revision)+1;return json({sessionId:'session-1',runId:'run-2',attemptId:'attempt-1',revision:state.session.revision},202);}
      if(path==='/settings/model'){state.settings={...state.settings,...body,revision:'b'.repeat(64),has_api_key:Boolean(body.api_key)||state.settings.has_api_key};return json(state.settings);}
      if(path==='/settings/model/test')return json({ok:true,message:'连接成功。'});
      if(path==='/sources'){state.sources.push({id:'source-2',title:body.title,version:1,digest:'b'.repeat(64),updatedAt:timestamp});return json({id:'source-2',version:1});}
      if(path==='/memories'){state.memories=[{...state.memories[0]!,...body,version:Number(body.revision)+1}];return json({key:body.key,version:Number(body.revision)+1});}
      if(path==='/schedules'){state.schedules.push({...body,id:'schedule-1',interval_seconds:body.intervalSeconds,next_run:body.nextRun,version:1});return json({id:'schedule-1',version:1});}
      if(path==='/approvals/approval-1/decision'){state.approvals[0]!.state='approved';return json({approvalId:'approval-1',state:'approved'});}
      return json({sessionId:'session-1',revision:2});
    }
    if(path==='/today')return json({goals:[state.goal],sessions:[state.session],unread:1,modelConfigured:true,workerOnline:true});
    if(path==='/goals')return json([state.goal]);
    if(path==='/goals/goal-1')return json({goal:state.goal,plan:{id:'plan-1',goalId:'goal-1',version:1,steps:[{id:'step-1',title:'写出一个验收标准',objective:'从具体使用场景描述需求',state:'practicing'}],rationale:'先把问题描述清楚，再考虑技术。',createdAt:timestamp},sessions:[state.session],attempts:state.attempts});
    if(path==='/sessions')return json({items:[state.session],total:1});
    if(path==='/sessions/session-1')return json({session:state.session,attempts:state.attempts,artifacts:[],approvals:state.approvals,legacy:state.legacy});
    if(path==='/sources')return json(state.sources);
    if(path.startsWith('/sources/')&&path.endsWith('/original')){state.originals.push(path+url.search);if(state.originalDelay)await new Promise(resolve=>setTimeout(resolve,state.originalDelay));state.completedOriginals.push(path+url.search);return route.fulfill({contentType:'application/pdf',body:Buffer.from('%PDF-1.7\ncourse original fixture\n')}).catch(()=>{});}
    if(path.startsWith('/sources/')){const source=state.sources.find(source=>source.id===path.split('/').at(-1));const version=Number(url.searchParams.get('version'))||source?.version||1;return json({...source,version,current_version:source?.version||1,content:'需求从使用者的具体问题开始。\n\n[不安全链接](javascript:alert(1))\n<script>window.__unsafe=true</script>',...state.sourceVersions[(source?.id||'')+'@'+version]});}
    if(path==='/search'){const course=url.searchParams.get('course')||'';state.searches.push(path+url.search);if(state.searchDelays[course])await new Promise(resolve=>setTimeout(resolve,state.searchDelays[course]));state.completedSearches.push(course);return json(state.session.citations.filter(citation=>!course||(citation.course||'unclassified')===course)).catch(()=>{});}
    if(path==='/memories')return json(state.memories);
    if(path.endsWith('/history'))return json([{key:'legacy-preference',version:1,snapshot:{content:'先提问再解释'},created_at:timestamp}]);
    if(path==='/schedules')return json(state.schedules);
    if(path==='/settings/model')return json(state.settings);
    if(path==='/notifications')return json({items:[{id:'notice-1',session_id:'session-1',title:'练习准备好了',body:'现在可以开始。',read_at:null,created_at:timestamp}],total:1});
    return json({error:{code:'not_found',message:'不存在'}},404);
  });
  await page.goto('/');if(login){await page.getByLabel('访问口令',{exact:true}).fill('test-token');await page.getByRole('button',{name:'进入',exact:true}).click();}await expect(page.getByRole('heading',{name:'今天，向前一步。'})).toBeVisible();return state;
}
async function secondary(page:Page,name:string){await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('link',{name,exact:true}).click();}

test('今天、目标、资料可用，手机不横向溢出',async({page},testInfo)=>{
  await setup(page);await expect(page.getByRole('navigation',{name:'主导航'}).getByRole('link')).toHaveCount(3);
  await page.screenshot({path:testInfo.outputPath('today.png'),fullPage:true});
  await page.getByRole('link',{name:'目标',exact:true}).click();await page.getByRole('link',{name:/理解软件工程的需求分析/}).click();await expect(page.getByRole('heading',{name:'学习路径'})).toBeVisible();
  await page.getByRole('link',{name:'资料',exact:true}).click();await expect(page.getByRole('link',{name:/第一讲：软件工程/})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
});
test('输入刷新与切页可恢复，退出清除会话草稿',async({page})=>{
  await setup(page);await page.getByLabel('想学什么').fill('每天学一点 TypeScript');await page.reload();await expect(page.getByLabel('想学什么')).toHaveValue('每天学一点 TypeScript');
  await page.getByRole('link',{name:'目标',exact:true}).click();await page.getByRole('link',{name:'今天',exact:true}).click();await expect(page.getByLabel('想学什么')).toHaveValue('每天学一点 TypeScript');
  await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('button',{name:'退出',exact:true}).click();await expect(page.getByRole('heading',{name:'继续你的学习。'})).toBeVisible();
  expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('assistant.v2.')))).toEqual([]);
});
test('创建目标携带资料与幂等键，并进入学习步骤',async({page})=>{
  const state=await setup(page);await page.getByLabel('想学什么').fill('一周学会需求分析');await page.getByText('补充要求',{exact:true}).click();await page.getByLabel('希望达到什么程度').fill('写出可验证的验收标准');await page.getByRole('checkbox',{name:'第一讲：软件工程'}).check();await page.getByRole('button',{name:'开始',exact:true}).click();
  await expect(page.getByRole('heading',{name:'一周学会需求分析',exact:true})).toBeVisible();expect(state.posts[0]!.body).toMatchObject({title:'一周学会需求分析',sourceIds:['source-1']});expect(state.posts[0]!.key).toMatch(/^[a-f0-9]{32}$/);
});
test('连接断开后保留输入，重试复用原请求键',async({page})=>{
  const state=fixture();state.abortCreate=true;await setup(page,state);await page.getByLabel('想学什么').fill('学习幂等请求');await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.getByRole('alert')).toContainText('输入已保留');await expect(page.getByLabel('想学什么')).toHaveValue('学习幂等请求');
  await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.getByRole('heading',{name:'学习幂等请求',exact:true})).toBeVisible();expect(state.posts).toHaveLength(2);expect(state.posts[0]!.key).toBe(state.posts[1]!.key);
});
test('版本冲突保留回答，显式载入后用新版本提交',async({page})=>{
  const state=fixture();state.conflictFeedback=true;await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await page.getByLabel('说说你的理解').fill('用户提交后 2 秒内看到保存结果。');await page.getByRole('button',{name:'继续',exact:true}).click();await expect(page.getByRole('alert')).toContainText('内容已更新');await expect(page.getByLabel('说说你的理解')).toHaveValue('用户提交后 2 秒内看到保存结果。');
  await page.getByRole('button',{name:'载入最新版本，保留输入'}).click();await expect(page.getByRole('status')).toContainText('最新版本已载入');await page.getByRole('button',{name:'继续',exact:true}).click();await expect(page.getByRole('button',{name:'停止',exact:true})).toBeVisible();expect(state.posts.at(-1)!.body).toMatchObject({revision:2,answer:'用户提交后 2 秒内看到保存结果。'});
});
test('中文检索能打开原文，Markdown 不执行脚本',async({page})=>{
  await setup(page);await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByLabel('查找资料',{exact:true}).fill('需求');await page.getByRole('button',{name:'查找',exact:true}).click();await expect(page.getByRole('heading',{name:'查找结果'})).toBeVisible();await page.getByRole('link',{name:'第一讲：软件工程',exact:true}).click();await expect(page.getByRole('heading',{name:'第一讲：软件工程'})).toBeVisible();expect(await page.evaluate(()=>Boolean((window as unknown as {__unsafe?:boolean}).__unsafe))).toBe(false);expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
});
test('设置密钥不进入草稿，保存与连接测试分开',async({page})=>{
  const state=await setup(page);await secondary(page,'设置');await page.getByLabel('API 密钥',{exact:true}).fill('private-example-key');expect(await page.evaluate(()=>JSON.stringify(sessionStorage))).not.toContain('private-example-key');await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(page.getByRole('status')).toContainText('配置已保存');expect(state.posts.at(-1)!.body.api_key).toBe('private-example-key');await expect(page.getByLabel('API 密钥',{exact:true})).toHaveValue('');await page.getByRole('button',{name:'测试已保存的连接'}).click();await expect(page.getByRole('status')).toContainText('连接成功');
});
test('旧偏好 scope 保留，独立计划可创建',async({page})=>{
  const state=await setup(page);await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByRole('tab',{name:'记忆与偏好'}).click();await page.getByRole('button',{name:'修改',exact:true}).click();await expect(page.getByLabel('用途')).toHaveValue('all');await page.getByRole('textbox',{name:'内容',exact:true}).fill('先给练习，再给解释。');await page.getByRole('button',{name:'保存偏好'}).click();await expect(page.getByText('先给练习，再给解释。',{exact:true})).toBeVisible();expect(state.posts.at(-1)!.body.scope).toBe('all');
  await secondary(page,'定时计划');await page.getByRole('button',{name:'添加计划'}).click();await page.getByLabel('计划名称').fill('晚间复盘');await page.getByLabel('要准备什么').fill('整理今天的错题。');await page.getByRole('button',{name:'保存计划'}).click();await expect(page.getByText('晚间复盘',{exact:true})).toBeVisible();expect(state.posts.at(-1)!.body.intervalSeconds).toBe(86400);
});
test('发送前显示确切邮件，发送中禁止改写',async({page})=>{
  const state=fixture();state.approvals=[{id:'approval-1',state:'pending',digest:'d'.repeat(64),payload:{action:'mail.send',sessionId:'session-1',revision:1,subject:'学习反馈',recipient:'teacher@example.com',sender:'student@example.com',draft:'这是经本人核对的回复。'},error:''}];await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await expect(page.getByText('teacher@example.com',{exact:true})).toBeVisible();await expect(page.getByText('这是经本人核对的回复。',{exact:true})).toBeVisible();await page.getByRole('button',{name:'确认发送这封邮件'}).click();await expect(page.getByText('等待发送',{exact:true})).toBeVisible();await page.getByText('更多操作',{exact:true}).click();await expect(page.getByRole('button',{name:'修改内容',exact:true})).toBeDisabled();expect(state.posts.at(-1)!.body).toEqual({digest:'d'.repeat(64),approve:true});
});
test('提交过程中新增的目标输入仍然保留',async({page})=>{
  const state=fixture();state.delayCreate=1200;await setup(page,state);await page.getByLabel('想学什么').fill('先提交的目标');await page.getByRole('button',{name:'开始',exact:true}).click();await expect.poll(()=>state.posts.length).toBe(1);await page.getByLabel('想学什么').fill('提交过程中想到的另一个目标');await expect(page.getByRole('heading',{name:'先提交的目标',exact:true})).toBeVisible();await page.getByRole('link',{name:'今天',exact:true}).click();await expect(page.getByLabel('想学什么')).toHaveValue('提交过程中想到的另一个目标');
});
test('保存期间继续改写保留新文字，并推进自己的版本',async({page})=>{
  const state=fixture();state.delayDraft=800;await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await page.getByText('更多操作',{exact:true}).click();await page.getByRole('button',{name:'修改内容',exact:true}).click();const editor=page.getByRole('textbox',{name:'修改内容',exact:true});await editor.fill('先保存的文字');await page.getByRole('button',{name:'保存内容',exact:true}).click();await expect.poll(()=>state.posts.length).toBe(1);await editor.fill('保存期间继续补充的文字');await expect(page.getByRole('status')).toContainText('已保存');await expect(editor).toHaveValue('保存期间继续补充的文字');await page.getByRole('button',{name:'保存内容',exact:true}).click();await expect.poll(()=>state.posts.length).toBe(2);expect(state.posts[1]!.body).toMatchObject({revision:2,content:'保存期间继续补充的文字'});
});
test('旧口令认证后迁移，实时连接从上次事件续读',async({page})=>{
  await page.addInitScript(()=>sessionStorage.setItem('gse-token','test-token'));const state=await setup(page,fixture(),false);await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('gse-token'))).toBe(null);expect(await page.evaluate(()=>sessionStorage.getItem('assistant.v2.token'))).toBe('test-token');await expect.poll(()=>state.events.includes('7')).toBe(true);await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('button',{name:'退出',exact:true}).click();expect(await page.evaluate(()=>sessionStorage.getItem('gse-token'))).toBe(null);
});

test('未评阅的回答不会标为模型估计',async({page})=>{
  const state=fixture();state.attempts=[{id:'attempt-1',sessionId:'session-1',answer:'我先写下自己的理解。',verdict:'unclear',feedback:'回答已保存，尚未评阅。',evidence:'',source:'ungraded',createdAt:timestamp}];await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await expect(page.getByText('未评阅',{exact:true})).toBeVisible();await expect(page.getByText('模型估计',{exact:false})).toHaveCount(0);await page.getByRole('link',{name:'‹ 返回目标',exact:true}).click();await page.getByText('练习与反馈（1）',{exact:true}).click();await expect(page.getByText(/^未评阅 ·/)).toBeVisible();await expect(page.getByText('模型估计',{exact:false})).toHaveCount(0);
});

test('迁移前记录默认折叠，历史引用安全展示且可完整下载',async({page})=>{
  const state=fixture();state.legacy={id:'session-1',packet:'## 旧材料\n请携带学生证。',sources:JSON.stringify([{path:'old/notice.md',text:'<img src=x onerror="window.__legacyUnsafe=true">原始历史摘录'}]),custom:'需要完整保留的字段'};await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await page.getByText('更多操作',{exact:true}).click();await expect(page.getByRole('heading',{name:'旧整理内容'})).toBeHidden();await page.getByText('迁移前记录',{exact:true}).click();await expect(page.getByText('历史引用未全部核验',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'旧材料',exact:true})).toBeVisible();await expect(page.getByText('old/notice.md',{exact:true})).toBeVisible();await expect(page.getByText('<img src=x onerror="window.__legacyUnsafe=true">原始历史摘录',{exact:true})).toBeVisible();expect(await page.evaluate(()=>Boolean((window as unknown as {__legacyUnsafe?:boolean}).__legacyUnsafe))).toBe(false);
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'下载完整旧记录（JSON）',exact:true}).click();const downloaded=await downloading;expect(JSON.parse(await readFile((await downloaded.path())!,'utf8'))).toEqual(state.legacy);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
for(const [label,sources] of [['缺失',undefined],['畸形','{broken'],['混合',[null,12,{path:'old/valid.md',text:'保留有效引用。'},{path:7,text:false}]]] as const){
  test(`迁移前记录稳健处理${label}历史引用`,async({page})=>{
    const state=fixture();state.legacy={id:'session-1',packet:null,...(sources===undefined?{}:{sources})};await setup(page,state);await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await page.getByText('更多操作',{exact:true}).click();await page.getByText('迁移前记录',{exact:true}).click();await expect(page.getByText(label==='缺失'?'没有保存历史引用。':'部分历史引用格式无法展开，可下载完整记录核对。',{exact:true})).toBeVisible();if(label==='混合')await expect(page.getByText('保留有效引用。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'下载完整旧记录（JSON）',exact:true})).toBeVisible();
  });
}

function courseFixture(){
  const state=fixture();
  const metadata=(course:string,courseName:string,originPath:string,format:string):SourceMetadata=>({course,courseName,originPath,format,originHash:'c'.repeat(64),extraction:format==='md'?'Markdown原文':'可检索文字提取',warnings:[],pages:[]});
  const original=metadata('database','数据库','database/slides/关系模型.pdf','pdf');original.assetKey='c'.repeat(64)+'.pdf';original.extraction='PDF文字层提取';original.warnings=['图片和公式可能缺失，请核对原文件。','第 2 页未提取到可检索文字。'];original.pages=[{number:1,start:0,end:20},{number:2,start:20,end:36}];
  state.sources.push(
    {id:'gse-1',title:'GSE第一讲',version:1,digest:'g'.repeat(64),updatedAt:timestamp,metadata:metadata('gse','GSE','gse/official/lect01.md','md')},
    {id:'gse-2',title:'GSE实验说明',version:1,digest:'g'.repeat(64),updatedAt:timestamp,metadata:metadata('gse','GSE','gse/official/lab1.md','md')},
    {id:'database-1',title:'数据库关系模型',version:3,digest:'d'.repeat(64),updatedAt:timestamp,metadata:{...original,originPath:'database/slides/关系模型新版.pdf'}},
    {id:'se-1',title:'软件工程需求分析',version:1,digest:'s'.repeat(64),updatedAt:timestamp,metadata:{...metadata('se','软件工程','se/slides/requirements.ppt','ppt'),pages:[{number:1,start:0,end:40}]}}
  );
  state.sourceVersions['database-1@2']={metadata:original};
  state.session.citations.push(...state.sources.slice(1).map(source=>({sourceId:source.id,title:source.title,version:source.id==='database-1'?2:1,start:0,end:20,quote:'可验证的课程资料摘录。',digest:source.digest,course:source.metadata!.course,courseName:source.metadata!.courseName,originPath:source.metadata!.originPath,location:source.id==='database-1'?'第 2 页':source.id==='se-1'?'幻灯片 1':undefined})));
  return state;
}

test('课程资料按课程筛选，检索传课程范围并保留未分类资料',async({page})=>{
  const state=await setup(page,courseFixture());await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByLabel('筛选课程').selectOption('database');await expect(page.getByRole('link',{name:/数据库关系模型/})).toBeVisible();await expect(page.getByRole('link',{name:/GSE第一讲/})).toHaveCount(0);await expect(page.getByText('数据库 · PDF · 第 3 版',{exact:true})).toBeVisible();
  await page.getByLabel('查找资料',{exact:true}).fill('可验证');await page.getByRole('button',{name:'查找',exact:true}).click();await expect(page.getByRole('link',{name:'数据库关系模型',exact:true})).toBeVisible();expect(state.searches.at(-1)).toContain('course=database');
  await page.getByLabel('筛选课程').selectOption('gse');await expect(page.getByRole('link',{name:'GSE第一讲',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'数据库关系模型',exact:true})).toHaveCount(0);expect(state.searches.at(-1)).toContain('course=gse');
  await page.getByLabel('筛选课程').selectOption('unclassified');await expect(page.getByRole('link',{name:'第一讲：软件工程',exact:true})).toBeVisible();expect(state.searches.at(-1)).toContain('course=unclassified');await page.getByRole('button',{name:'返回资料列表'}).click();await expect(page.getByText('未分类 · 文本 · 第 1 版',{exact:true})).toBeVisible();await page.getByRole('link',{name:/第一讲：软件工程/}).click();await expect(page.getByRole('heading',{name:'第一讲：软件工程',exact:true})).toBeVisible();await expect(page.getByText('来源与提取说明',{exact:false})).toHaveCount(0);
});

test('课程目标选择全课资料，逐项取消和切回全部均保留准确范围',async({page})=>{
  const state=await setup(page,courseFixture());await page.getByLabel('想学什么').fill('学习GSE课程');await page.getByText('补充要求',{exact:true}).click();await page.getByLabel('关联课程').selectOption('gse');await expect(page.getByRole('checkbox',{name:'GSE第一讲',exact:true})).toBeChecked();await expect(page.getByRole('checkbox',{name:'GSE实验说明',exact:true})).toBeChecked();await page.getByRole('checkbox',{name:'GSE实验说明',exact:true}).uncheck();await page.getByLabel('关联课程').selectOption('');await expect(page.getByRole('checkbox',{name:'数据库关系模型',exact:true})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'第一讲：软件工程',exact:true})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'GSE实验说明',exact:true})).not.toBeChecked();
  await page.getByLabel('关联课程').selectOption('database');await expect(page.getByRole('checkbox',{name:'数据库关系模型',exact:true})).toBeChecked();await page.getByLabel('关联课程').selectOption('gse');await page.getByRole('checkbox',{name:'GSE实验说明',exact:true}).uncheck();await page.getByLabel('关联课程').selectOption('');await expect(page.getByRole('checkbox',{name:'数据库关系模型',exact:true})).not.toBeChecked();await expect(page.getByText('已关联 1 份资料。',{exact:false})).toBeVisible();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.getByRole('heading',{name:'学习GSE课程',exact:true})).toBeVisible();expect(state.posts.at(-1)!.body.sourceIds).toEqual(['gse-1']);
});

test('课程引用展示页码，来源说明和原文件下载绑定引用版本',async({page},testInfo)=>{
  const state=await setup(page,courseFixture());await page.getByRole('link',{name:/理解软件工程的需求分析/}).first().click();await page.getByText('参考资料 · 5',{exact:true}).click();await expect(page.getByText('数据库 · 第 2 页 · 第 2 版',{exact:false})).toBeVisible();await page.getByRole('link',{name:'数据库关系模型',exact:true}).click();await expect(page.getByText('database/slides/关系模型.pdf',{exact:true})).toBeHidden();await page.getByText('来源与提取说明',{exact:false}).click();await expect(page.getByText('database/slides/关系模型.pdf',{exact:true})).toBeVisible();await expect(page.getByText('PDF文字层提取',{exact:true})).toBeVisible();await expect(page.getByText('1–2（沿用原文件页序）',{exact:true})).toBeVisible();await expect(page.getByText('图片和公式可能缺失，请核对原文件。',{exact:true})).toBeVisible();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载原文件',exact:true}).click();const file=await pending;expect(file.suggestedFilename()).toBe('关系模型.pdf');expect((await readFile((await file.path())!)).toString()).toContain('%PDF-1.7');expect(state.originals).toEqual(['/sources/database-1/original?version=2']);expect(page.url()).not.toContain('test-token');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();await page.screenshot({path:testInfo.outputPath('course-source.png'),fullPage:true});
  await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByRole('link',{name:/软件工程需求分析/}).click();await page.getByText('来源与提取说明',{exact:false}).click();await expect(page.locator('dt').filter({hasText:/^幻灯片$/})).toBeVisible();await expect(page.getByText('1（沿用原文件页序）',{exact:true})).toBeVisible();
});

test('课程检索切换不会被旧课程的迟到响应覆盖',async({page})=>{
  const state=courseFixture();state.searchDelays.gse=800;await setup(page,state);await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByLabel('筛选课程').selectOption('gse');await page.getByLabel('查找资料',{exact:true}).fill('可验证');await page.getByRole('button',{name:'查找',exact:true}).click();await expect.poll(()=>state.searches.some(url=>url.includes('course=gse'))).toBe(true);await page.getByLabel('筛选课程').selectOption('database');await expect(page.getByRole('link',{name:'数据库关系模型',exact:true})).toBeVisible();await expect.poll(()=>state.completedSearches.includes('gse')).toBe(true);await expect(page.getByRole('link',{name:'GSE第一讲',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'数据库关系模型',exact:true})).toBeVisible();
});

test('课程原文件下载退出后中止，不产生迟到下载',async({page})=>{
  const state=courseFixture();state.originalDelay=900;await setup(page,state);await page.getByRole('link',{name:'资料',exact:true}).click();await page.getByRole('link',{name:/数据库关系模型/}).click();let downloads=0;page.on('download',()=>downloads++);await page.getByRole('button',{name:'下载原文件',exact:true}).click();await expect.poll(()=>state.originals.length).toBe(1);await page.locator('summary').filter({hasText:/^更多/}).click();await page.getByRole('button',{name:'退出',exact:true}).click();await expect(page.getByRole('heading',{name:'继续你的学习。'})).toBeVisible();await expect.poll(()=>state.completedOriginals.length).toBe(1);expect(downloads).toBe(0);
});

test('课程资料超过目标上限时明确提示且不静默裁剪',async({page})=>{
  const state=courseFixture(),template=state.sources.find(source=>source.id==='gse-1')!;state.sources=Array.from({length:101},(_,index)=>({...template,id:'gse-many-'+index,title:'GSE资料 '+index}));await setup(page,state);await page.getByLabel('想学什么').fill('学习全部GSE资料');await page.getByText('补充要求',{exact:true}).click();await page.getByLabel('关联课程').selectOption('gse');await expect(page.getByRole('alert')).toContainText('已关联 101 份资料，单个目标最多关联 100 份');await expect(page.getByRole('button',{name:'开始',exact:true})).toBeDisabled();await page.getByRole('checkbox',{name:'GSE资料 0',exact:true}).uncheck();await expect(page.getByRole('button',{name:'开始',exact:true})).toBeEnabled();expect(state.posts).toHaveLength(0);
});

test('课程资料取消全部后保持空绑定，不扩大到其他课程',async({page})=>{
  const state=await setup(page,courseFixture());await page.getByLabel('想学什么').fill('暂不关联资料的学习目标');await page.getByText('补充要求',{exact:true}).click();await page.getByLabel('关联课程').selectOption('gse');await page.getByRole('checkbox',{name:'GSE第一讲',exact:true}).uncheck();await page.getByRole('checkbox',{name:'GSE实验说明',exact:true}).uncheck();await expect(page.getByText('未关联资料，可在下方选择。',{exact:true})).toBeVisible();await page.getByLabel('关联课程').selectOption('');await expect(page.getByRole('checkbox',{name:'数据库关系模型',exact:true})).not.toBeChecked();await page.getByRole('button',{name:'开始',exact:true}).click();await expect(page.getByRole('heading',{name:'暂不关联资料的学习目标',exact:true})).toBeVisible();expect(state.posts.at(-1)!.body.sourceIds).toEqual([]);
});
