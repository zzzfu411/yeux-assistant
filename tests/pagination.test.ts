import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PgBoss } from 'pg-boss';
import { Store } from '../packages/storage/src/index.js';
import { Application } from '../packages/core/src/application.js';
import { initializeData } from '../packages/core/src/config.js';
import { GoalListQuery,SessionListQuery,AttemptListQuery,SessionSummary } from '../packages/contracts/src/pagination.js';
import { buildServer } from '../apps/api/src/server.js';

it('bounds pagination inputs and rejects arbitrary filters and oversized cursors',()=>{
  expect(GoalListQuery.parse({})).toMatchObject({limit:30,q:'',status:'all'});
  for(const value of [{limit:0},{limit:51},{cursor:'x'.repeat(2049)},{status:'deleted'},{q:'x'.repeat(201)},{order:'random'}])expect(GoalListQuery.safeParse(value).success).toBe(false);
  expect(SessionListQuery.safeParse({goalId:'',state:'unknown'}).success).toBe(false);
  expect(AttemptListQuery.safeParse({q:'ignored'}).success).toBe(false);
});
const url=process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('stable collection pages with real PostgreSQL',()=>{
  let store:Store,app:Application,folder:string;
  beforeAll(()=>{if(!new URL(url!).pathname.endsWith('_test'))throw new Error('Only isolated *_test databases are allowed');store=new Store(url);});
  beforeEach(async()=>{
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');await store.migrate();folder=await mkdtemp(join(tmpdir(),'yeux-pagination-'));const token=await initializeData(folder);app=new Application(store,{} as PgBoss,folder,token);
    await store.exec("INSERT INTO app.goals(id,title,status,created_at) SELECT 'goal-'||lpad(i::text,3,'0'),'学习目标 '||i,CASE WHEN i%2=0 THEN 'paused' ELSE 'active' END,'2026-01-01T00:00:00.123456Z'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,201) i");
    await store.exec("INSERT INTO app.sessions(id,goal_id,title,kind,prompt,state,content,citations,created_at) SELECT 'session-'||lpad(i::text,3,'0'),'goal-001','学习记录 '||i,CASE WHEN i%2=0 THEN 'work' ELSE 'study' END,repeat('材',30000),'completed',repeat('文',100000),'[{\"private\":\"not-list-data\"}]'::jsonb,'2026-01-01T01:00:00.123456Z'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,51) i");
    await store.exec("INSERT INTO app.attempts(id,session_id,answer,verdict,source,created_at) SELECT 'attempt-'||lpad(i::text,3,'0'),'session-'||lpad(((i-1)%51+1)::text,3,'0'),'回答 '||i,'unclear','ungraded','2026-01-01T02:00:00.123456Z'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,101) i");
  });
  afterEach(async()=>{await rm(folder,{recursive:true,force:true});});afterAll(async()=>{await store?.close();});
  it('reaches all 201 goals with microsecond timestamps and no duplicate boundary rows',async()=>{
    const ids:string[]=[];let cursor:string|undefined;
    do{const page=await app.goalList({limit:30,...(cursor?{cursor}:{})});expect(page.total).toBe(201);ids.push(...page.items.map(item=>item.id));cursor=page.nextCursor||undefined;}while(cursor);
    expect(ids).toHaveLength(201);expect(new Set(ids).size).toBe(201);expect(ids[0]).toBe('goal-201');expect(ids.at(-1)).toBe('goal-001');
    // Equal timestamps use the immutable ID as a deterministic tie breaker.
    await store.exec("UPDATE app.goals SET created_at='2026-01-01'");
    const tied:string[]=[];cursor=undefined;
    do{const page=await app.goalList({limit:50,...(cursor?{cursor}:{})});tied.push(...page.items.map(item=>item.id));cursor=page.nextCursor||undefined;}while(cursor);
    expect(tied).toEqual(ids);
  });
  it('exposes the 51st session and 101st attempt while retaining legacy response shapes and true counts',async()=>{
    const sessions=await app.sessionList({goalId:'goal-001',limit:50});expect(sessions.total).toBe(51);expect(sessions.items).toHaveLength(50);
    expect((await app.sessionList({goalId:'goal-001',limit:50,cursor:sessions.nextCursor!})).items.map(item=>item.id)).toEqual(['session-001']);
    const attempts:string[]=[];let cursor:string|undefined;
    do{const page=await app.goalAttempts('goal-001',{limit:50,...(cursor?{cursor}:{})});expect(page.total).toBe(101);attempts.push(...page.items.map(item=>item.id));cursor=page.nextCursor||undefined;}while(cursor);
    expect(attempts).toHaveLength(101);expect(attempts.at(-1)).toBe('attempt-001');
    const legacy=await app.goal('goal-001');expect(legacy.sessions).toHaveLength(50);expect(legacy.attempts).toHaveLength(100);expect(legacy).toMatchObject({sessionTotal:51,attemptTotal:101});
    const overview=await app.goal('goal-001',true);expect(overview).not.toHaveProperty('sessions');expect(overview).not.toHaveProperty('attempts');
    expect(await app.goals()).toHaveLength(200);expect((await app.history()).items[0]).toHaveProperty('content');
  });
  it('keeps page positions stable when newer records arrive and permits explicit fresh reads',async()=>{
    const first=await app.sessionList({goalId:'goal-001',limit:30});
    await store.exec("INSERT INTO app.sessions(id,goal_id,title,kind,prompt,state) VALUES('new-session','goal-001','新任务','study','new','completed')");
    const next=await app.sessionList({goalId:'goal-001',limit:30,cursor:first.nextCursor!});
    const repeated=await app.sessionList({goalId:'goal-001',limit:30,cursor:first.nextCursor!});expect(repeated).toEqual(next);
    const back=await app.sessionList({goalId:'goal-001',limit:30,cursor:first.pageCursor});expect(back).toEqual(first);
    const combined=[...first.items,...next.items].map(item=>item.id);expect(combined).toHaveLength(51);expect(new Set(combined).size).toBe(51);expect(combined).not.toContain('new-session');
    const fresh=await app.sessionList({goalId:'goal-001',limit:30});expect(fresh.total).toBe(52);expect(fresh.items[0]!.id).toBe('new-session');
  });
  it('binds a signed cursor to resource, goal, filters and page size',async()=>{
    const first=await app.goalList({limit:30});const cursor=first.nextCursor!;
    for(const input of [{cursor,status:'paused'},{cursor,q:'学习'},{cursor,limit:50}])await expect(app.goalList(input)).rejects.toMatchObject({code:'invalid_cursor'});
    await expect(app.sessionList({cursor})).rejects.toMatchObject({code:'invalid_cursor'});
    const signature=cursor.at(-1)==='a'?'b':'a';await expect(app.goalList({cursor:cursor.slice(0,-1)+signature})).rejects.toMatchObject({code:'invalid_cursor'});
    const attempts=await app.goalAttempts('goal-001',{limit:30});await expect(app.goalAttempts('goal-002',{cursor:attempts.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  });
  it('filters by literal titles, status, kind and goal without treating wildcard characters as a query language',async()=>{
    await store.exec("UPDATE app.goals SET title='literal %_ title' WHERE id='goal-001'");await store.exec("UPDATE app.goals SET title='literal ab title' WHERE id='goal-002'");
    expect((await app.goalList({q:'%_'})).items.map(item=>item.id)).toEqual(['goal-001']);expect((await app.goalList({q:"' OR true --"})).items).toEqual([]);
    expect((await app.goalList({status:'paused'})).total).toBe(100);
    const work=await app.sessionList({goalId:'goal-001',kind:'work',q:'学习记录 ',state:'completed'});expect(work.total).toBe(25);expect(work.items.every(item=>item.kind==='work')).toBe(true);
    expect((await app.sessionList({goalId:'goal-002'})).total).toBe(0);await expect(app.sessionList({goalId:'missing'})).rejects.toMatchObject({status:404});
  });
  it('returns bounded summaries, exact homepage counts and at most three pending tasks',async()=>{
    const list=await app.sessionList();expect(JSON.stringify(list).length).toBeLessThan(25000);
    for(const item of list.items){expect(SessionSummary.safeParse(item).success).toBe(true);for(const key of ['content','citations','prompt','recipient','currentRunId'])expect(item).not.toHaveProperty(key);expect(item.promptPreview.length).toBe(160);}
    await store.exec("INSERT INTO app.sessions(id,title,kind,prompt,state) SELECT 'pending-'||i,'待办 '||i,'study',repeat('😀',200),'failed' FROM generate_series(1,7) i");
    const overview=await app.today(true);expect(overview).toMatchObject({goalTotal:201,activeGoalTotal:101,pendingTotal:7});expect(overview.sessions).toHaveLength(3);expect(overview).not.toHaveProperty('goals');expect(overview.sessions.every(item=>SessionSummary.safeParse(item).success)).toBe(true);
  });
  it('keeps thousands of historical records discoverable while reading only one bounded page',async()=>{
    await store.exec("INSERT INTO app.sessions(id,goal_id,title,kind,prompt,state,content,created_at) SELECT 'scale-'||lpad(i::text,5,'0'),'goal-002','长期记录 '||i,'study','练习材料','completed',repeat('正文',10000),'2025-01-01'::timestamptz+i*interval '1 second' FROM generate_series(1,5000) i");
    await store.exec('ANALYZE app.sessions');
    const page=await app.sessionList({goalId:'goal-002'});expect(page.total).toBe(5000);expect(page.items).toHaveLength(30);expect(JSON.stringify(page).length).toBeLessThan(25000);
    const plan=await store.one("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT s.id,s.goal_id,s.title,s.kind,s.state,left(s.prompt,160),left(s.error,240),s.created_at,s.updated_at FROM app.sessions s WHERE s.goal_id=$1 AND s.created_at<=$2::timestamptz ORDER BY s.created_at DESC,s.id DESC LIMIT 31",['goal-002',new Date().toISOString()]);
    const explain=plan!['QUERY PLAN'][0];const nodes:string[]=[];const collect=(node:Record<string,any>)=>{nodes.push(node['Node Type']);for(const child of node.Plans||[])collect(child);};collect(explain.Plan);
    console.info('Collection scale query:',JSON.stringify({rows:5000,returned:explain.Plan['Actual Rows'],milliseconds:explain['Execution Time'],nodes}));
  });
  it('enforces read authentication and shared query validation on the new API routes',async()=>{
    const built=await buildServer({url,folder,assets:false});
    try{const headers={authorization:'Bearer '+(await readFile(join(folder,'access-token'),'utf8')).trim()};
      for(const path of ['/goals/list','/sessions/list','/goals/goal-001/attempts/list','/goals/goal-001/overview','/today/overview'])expect((await built.server.inject({url:'/api/v2'+path})).statusCode).toBe(401);
      expect((await built.server.inject({url:'/api/v2/goals/list?limit=51',headers})).statusCode).toBe(400);expect((await built.server.inject({url:'/api/v2/sessions/list?unknown=1',headers})).statusCode).toBe(400);
      const response=await built.server.inject({url:'/api/v2/sessions/list?goalId=goal-001',headers});expect(response.statusCode).toBe(200);expect(response.json().total).toBe(51);expect(response.json().items[0]).not.toHaveProperty('content');
      expect((await built.server.inject({url:'/api/v2/goals/goal-001/overview',headers})).json()).toMatchObject({sessionTotal:51,attemptTotal:101});
    }finally{await built.server.close();}
  });
});
