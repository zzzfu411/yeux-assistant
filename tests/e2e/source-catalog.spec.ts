import { test, expect, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { SourceSummary } from '../../packages/contracts/src/index';

const timestamp='2026-10-03T04:00:00.000Z';
const names=['GSE','数据库','软件工程'],courses=['gse','database','se'];
function catalog(count:number):SourceSummary[]{return Array.from({length:count},(_,index)=>({id:'synthetic-'+index,title:`${names[index%3]} · 合成资料 ${String(index).padStart(5,'0')}`,version:1,revision:1,digest:'d'.repeat(64),updatedAt:timestamp,archivedAt:null,managed:false,metadata:{course:courses[index%3]!,courseName:names[index%3]!,format:'md'}}));}
function fixture(count=180){return {sources:catalog(count),archived:[] as SourceSummary[],reads:[] as string[],posts:[] as string[],searches:[] as string[],fail:false,sseUrl:''};}
type State=ReturnType<typeof fixture>;
async function setup(page:Page,state=fixture()){
  let signedIn=false;
  await page.route('**/api/v2/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v2','');
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/auth/login'){signedIn=true;return json({username:'tester'});}
    if(!signedIn)return json({error:{code:'unauthorized',message:'请登录管理员账号。'}},401);
    if(path==='/auth/session')return json({username:'tester'});
    if(path==='/events')return state.sseUrl?route.continue({url:state.sseUrl}):route.fulfill({contentType:'text/event-stream',body:': connected\n\n'});
    if(request.method()!=='GET'){state.posts.push(path);return json({ok:true});}
    state.reads.push(path+url.search);
    if(path==='/today/overview')return json({goalTotal:1,activeGoalTotal:1,pendingTotal:0,sessions:[],unread:0,modelConfigured:true,workerOnline:true});
    if(path==='/sources')return state.fail?json({error:{code:'unavailable',message:'合成目录暂时不可用。'}},503):json(url.searchParams.get('archived')==='true'?state.archived:state.sources);
    if(path==='/goals/synthetic-goal/overview')return json({goal:{id:'synthetic-goal',title:'合成学习目标',outcome:'',status:'active',revision:1,sourceIds:[],intervals:[86400],reviewStage:0,nextReview:null,createdAt:timestamp,updatedAt:timestamp},plan:null,sessionTotal:0,attemptTotal:0});
    if(path==='/sessions/list')return json({items:[],total:0,pageCursor:'test-page',nextCursor:null});
    if(path==='/search'){state.searches.push(url.search);const row=state.sources[0]!;return json([{sourceId:row.id,version:1,title:row.title,start:0,end:20,quote:'这段合成正文包含标题中没有的事务隔离关键词。',digest:row.digest,course:row.metadata!.course,courseName:row.metadata!.courseName}]);}
    return json({error:{code:'not_found',message:'未定义测试接口。'}},404);
  });
  await page.goto('/');await page.getByLabel('账号',{exact:true}).fill('tester');await page.getByLabel('密码',{exact:true}).fill('test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('heading',{name:'学习工作台'})).toBeVisible();return state;
}
async function openPicker(page:Page){await page.getByRole('button',{name:'学习设置',exact:true}).click();await expect(page.getByRole('group',{name:'关联资料',exact:true})).toBeVisible();}
const selected=(page:Page)=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('assistant.v2.draft.new-goal')!).sourceIds as string[]);
const sourceReads=(state:State)=>state.reads.filter(path=>path==='/sources').length;
const pickerPages=(page:Page)=>page.getByRole('group',{name:'资料选择分页',exact:true});

test('首页与目标详情只有打开资料选择时才请求摘要',async({page})=>{
  const state=await setup(page);expect(sourceReads(state)).toBe(0);await page.getByRole('group',{name:'选择功能'}).getByRole('button',{name:'整理材料',exact:true}).click();expect(sourceReads(state)).toBe(0);
  await page.goto('/#/goal/synthetic-goal');await expect(page.getByRole('heading',{name:'合成学习目标',exact:true})).toBeVisible();expect(sourceReads(state)).toBe(0);await page.getByRole('button',{name:'调整目标',exact:true}).click();await expect(page.getByRole('checkbox')).toHaveCount(30);expect(sourceReads(state)).toBe(1);expect(state.posts).toEqual([]);
});

test('选择跨课程、分页、标题筛选和刷新保留，筛选从不自动关联',async({page},testInfo)=>{
  const state=await setup(page);await openPicker(page);await page.getByRole('checkbox',{name:state.sources[0]!.title,exact:true}).check();await page.getByRole('combobox',{name:'筛选课程',exact:true}).selectOption('gse');await expect(page.getByRole('checkbox')).toHaveCount(30);expect(await selected(page)).toEqual(['synthetic-0']);
  await pickerPages(page).getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('checkbox',{name:state.sources[90]!.title,exact:true}).check();await page.getByRole('combobox',{name:'筛选课程',exact:true}).selectOption('database');await expect(page.getByRole('checkbox',{name:state.sources[1]!.title,exact:true})).not.toBeChecked();await page.getByRole('checkbox',{name:state.sources[1]!.title,exact:true}).check();
  await page.getByRole('combobox',{name:'筛选课程',exact:true}).selectOption('');await page.getByLabel('按标题筛选',{exact:true}).fill('00179');await expect(page.getByRole('checkbox')).toHaveCount(1);await page.getByRole('checkbox',{name:state.sources[179]!.title,exact:true}).check();expect(await selected(page)).toEqual(['synthetic-0','synthetic-90','synthetic-1','synthetic-179']);
  await page.getByRole('button',{name:'刷新资料',exact:true}).click();await expect(page.getByRole('button',{name:'刷新资料',exact:true})).toBeEnabled();await page.reload();await openPicker(page);await page.getByRole('button',{name:'只看已关联',exact:true}).click();await expect(page.getByRole('checkbox')).toHaveCount(4);await expect(page.getByRole('checkbox',{name:state.sources[179]!.title,exact:true})).toBeChecked();expect(await selected(page)).toEqual(['synthetic-0','synthetic-90','synthetic-1','synthetic-179']);expect(state.posts).toEqual([]);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:testInfo.outputPath('retained-selection.png'),fullPage:true,scale:'css'});
});

test('关联本页只追加30项，超过100时整体拒绝且不截断，单项也受上限约束',async({page})=>{
  const state=await setup(page);await openPicker(page);
  for(let index=0;index<3;index++){await page.getByRole('button',{name:'关联本页',exact:true}).click();await pickerPages(page).getByRole('button',{name:'下一页',exact:true}).click();}
  expect(await selected(page)).toHaveLength(90);await page.getByRole('button',{name:'关联本页',exact:true}).click();await expect(page.getByRole('alert')).toContainText('本次关联后将有 120 份资料');expect(await selected(page)).toHaveLength(90);await expect(page.getByRole('checkbox',{name:state.sources[90]!.title,exact:true})).not.toBeChecked();
  for(let index=90;index<100;index++)await page.getByRole('checkbox',{name:state.sources[index]!.title,exact:true}).check();expect(await selected(page)).toHaveLength(100);
  await page.getByRole('checkbox',{name:state.sources[100]!.title,exact:true}).click();await expect(page.getByRole('alert')).toContainText('本次关联后将有 101 份资料');await expect(page.getByRole('checkbox',{name:state.sources[100]!.title,exact:true})).not.toBeChecked();expect(await selected(page)).toEqual(state.sources.slice(0,100).map(source=>source.id));expect(state.posts).toEqual([]);
});

test('资料库使用中和归档均按标题查找，正文检索有独立入口和原文位置',async({page})=>{
  const state=fixture(180);state.archived=[{...state.sources[179]!,id:'archive-179',archivedAt:timestamp}];await setup(page,state);await page.getByRole('link',{name:'资料',exact:true}).click();await expect(page.locator('a[href^="#/source/"]')).toHaveCount(30);await page.getByLabel('按标题查找',{exact:true}).fill('00179');await expect(page.locator('a[href^="#/source/"]')).toHaveCount(1);expect(state.searches).toEqual([]);
  await page.getByRole('combobox',{name:'资料范围',exact:true}).selectOption('true');await expect(page.locator('a[href="#/source/archive-179"]')).toBeVisible();await expect(page.getByText('检索正文片段',{exact:true})).toHaveCount(0);await page.getByLabel('按标题查找',{exact:true}).fill('不存在的资料');await expect(page.getByText('没有符合条件的资料。',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'资料范围',exact:true}).selectOption('false');await page.getByLabel('按标题查找',{exact:true}).fill('00179');await page.getByText('检索正文片段',{exact:true}).click();await page.getByLabel('正文关键词',{exact:true}).fill('事务隔离');await page.getByRole('button',{name:'检索正文',exact:true}).click();const results=page.getByRole('region',{name:'正文片段结果',exact:true});await expect(results.getByText('这段合成正文包含标题中没有的事务隔离关键词。',{exact:true})).toBeVisible();await expect(results.getByText(/字符 1–20/)).toBeVisible();expect(state.searches.at(-1)).toContain('q=%E4%BA%8B%E5%8A%A1%E9%9A%94%E7%A6%BB');await expect(page.getByLabel('按标题查找',{exact:true})).toHaveValue('00179');expect(state.posts).toEqual([]);
});

for(const count of [3000,10000])test(`${count}份合成摘要按30项渲染并量测选择与标题查找`,async({page},testInfo)=>{
  const state=fixture(count);await setup(page,state);const initialDom=await page.locator('*').count(),start=performance.now();await openPicker(page);await expect(page.getByRole('checkbox')).toHaveCount(30);const panelReadyMs=performance.now()-start,checkboxes=await page.getByRole('checkbox').count(),panelDom=await page.locator('*').count();
  const searchStart=performance.now();await page.getByLabel('按标题筛选',{exact:true}).fill(String(count-1).padStart(5,'0'));await expect(page.getByRole('checkbox')).toHaveCount(1);await page.getByRole('checkbox',{name:state.sources[count-1]!.title,exact:true}).check();const findAndSelectMs=performance.now()-searchStart;
  expect(await selected(page)).toEqual(['synthetic-'+(count-1)]);await page.getByRole('link',{name:'资料',exact:true}).click();await expect(page.locator('a[href^="#/source/"]')).toHaveCount(30);const libraryDom=await page.locator('*').count();const nextStart=performance.now();await page.getByRole('group',{name:'资料库分页'}).getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('a[href="#/source/synthetic-30"]')).toBeVisible();const nextPageMs=performance.now()-nextStart;
  expect(panelDom-initialDom).toBeLessThan(300);expect(libraryDom).toBeLessThan(600);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const metrics={synthetic:true,records:count,project:testInfo.project.name,serializedSummaryBytes:Buffer.byteLength(JSON.stringify(state.sources),'utf8'),checkboxes,initialDom,panelDom,libraryDom,panelReadyMs,findAndSelectMs,nextPageMs,note:'未压缩合成摘要 JSON 字节；时间包含浏览器动作与断言开销，不代表公网或真实手机性能。'};
  await writeFile(testInfo.outputPath('catalog-metrics.json'),JSON.stringify(metrics,null,2));await testInfo.attach('catalog-metrics',{body:JSON.stringify(metrics,null,2),contentType:'application/json'});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:testInfo.outputPath('catalog-page-2.png'),fullPage:true,scale:'css'});expect(state.posts).toEqual([]);
});

test('持续SSE连接按资料域刷新，普通任务不重载且迁移加入资料后保留关联',async({page})=>{
  const state=fixture(3),connections=new Set<ServerResponse>();
  const server=createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});response.write(': connected\n\n');connections.add(response);request.on('close',()=>connections.delete(response));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Test stream port missing');state.sseUrl=`http://127.0.0.1:${address.port}/events`;
  let sequence=0;const send=(kind:string)=>{const id=String(++sequence);for(const response of connections)response.write('id: '+id+'\ndata: '+JSON.stringify({id,kind,entityId:'synthetic-0',data:{},createdAt:timestamp})+'\n\n');};
  try{
    await setup(page,state);await expect.poll(()=>connections.size).toBe(1);await openPicker(page);await page.getByRole('checkbox',{name:state.sources[0]!.title,exact:true}).check();const before=sourceReads(state),todayBefore=state.reads.filter(path=>path==='/today/overview').length;
    send('session.updated');send('device.updated');await expect.poll(()=>state.reads.filter(path=>path==='/today/overview').length).toBeGreaterThan(todayBefore);expect(sourceReads(state)).toBe(before);
    state.sources[0]={...state.sources[0]!,title:'更新后的合成材料'};send('source.updated');await expect(page.getByRole('checkbox',{name:'更新后的合成材料',exact:true})).toBeChecked();expect(sourceReads(state)).toBe(before+1);expect(await selected(page)).toEqual(['synthetic-0']);
    state.sources.push({...catalog(1)[0]!,id:'legacy-added',title:'迁移加入的合成资料'});send('legacy.imported');await expect(page.getByRole('checkbox',{name:'迁移加入的合成资料',exact:true})).toBeVisible();await expect(page.getByRole('checkbox',{name:'迁移加入的合成资料',exact:true})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'更新后的合成材料',exact:true})).toBeChecked();expect(sourceReads(state)).toBe(before+2);expect(await selected(page)).toEqual(['synthetic-0']);
    state.sources=state.sources.slice(1);send('source.archived');await expect(page.getByText('有 1 份关联资料已归档或不可用。原关联仍保留。',{exact:true})).toBeVisible();expect(await selected(page)).toEqual(['synthetic-0']);await page.getByRole('button',{name:'移除不可用关联',exact:true}).click();expect(await selected(page)).toEqual([]);expect(state.posts).toEqual([]);
  }finally{for(const response of connections)response.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('375px、横屏与20px大字下资料选择可点击且不横向溢出',async({page},testInfo)=>{
  const state=fixture(36);state.sources[0]!.title='课程资料标题与练习说明'.repeat(12);await page.emulateMedia({reducedMotion:'reduce'});await setup(page,state);await openPicker(page);
  await page.addStyleTag({content:'fieldset :where(label,button,input,select,span,small,p,legend){font-size:20px!important}'});
  for(const viewport of [{width:375,height:812},{width:812,height:375}]){
    await page.setViewportSize(viewport);const box=await page.getByRole('group',{name:'关联资料',exact:true}).boundingBox();expect(box).not.toBeNull();expect(box!.width).toBeLessThanOrEqual(viewport.width);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const row=page.getByRole('checkbox',{name:state.sources[0]!.title,exact:true}).locator('..');expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);await row.click();await expect(page.getByRole('checkbox',{name:state.sources[0]!.title,exact:true})).toBeChecked();await row.click();await expect(page.getByRole('checkbox',{name:state.sources[0]!.title,exact:true})).not.toBeChecked();
    await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:testInfo.outputPath(`selection-large-text-${viewport.width}.png`),fullPage:true,scale:'css'});
  }
  expect(state.posts).toEqual([]);
});
