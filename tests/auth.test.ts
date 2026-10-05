import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../apps/api/src/server.js';
import { setAdministrator } from '../packages/core/src/auth.js';
import { Store } from '../packages/storage/src/index.js';

const url=process.env.API_TEST_DATABASE_URL;
describe.skipIf(!url)('administrator password and persistent server sessions',()=>{
 let built:Awaited<ReturnType<typeof buildServer>>,folder:string;
 const credentials={username:'fixture-admin',password:'Synthetic-only-password!'};
 beforeAll(async()=>{
  if(!new URL(url!).pathname.endsWith('_test'))throw new Error('Dedicated test database required');
  const store=new Store(url);await store.exec('DROP SCHEMA IF EXISTS queue CASCADE');await store.exec('DROP SCHEMA IF EXISTS app CASCADE');await store.close();
  folder=await mkdtemp(join(tmpdir(),'yeux-auth-'));built=await buildServer({url,folder,assets:false});
 });
 beforeEach(async()=>{await built.store.exec('DELETE FROM app.auth_limits');await built.store.exec('DELETE FROM app.auth_sessions');await setAdministrator(folder,credentials.username,credentials.password);});
 afterAll(async()=>{await built?.server.close();if(folder)await rm(folder,{recursive:true,force:true});});
 const login=(payload:unknown=credentials,origin?:string)=>built.server.inject({method:'POST',url:'/api/v2/auth/login',payload,headers:origin?{origin}:{}});
 const get=(cookie:string)=>built.server.inject({url:'/api/v2/today',headers:{cookie}});
 const cookie=(result:any)=>String(result.headers['set-cookie']).split(';')[0]!;
 it('stores only a salted password hash and issues a private cookie, not an API key',async()=>{
  const file=await readFile(join(folder,'admin-auth.json'),'utf8');expect(file).not.toContain(credentials.password);
  const result=await login();expect(result.statusCode).toBe(200);expect(result.json()).toEqual({username:credentials.username});
  expect(result.headers['set-cookie']).toContain('HttpOnly');expect(result.headers['set-cookie']).toContain('SameSite=Strict');
  expect((await get(cookie(result))).statusCode).toBe(200);
  const stored=await built.store.one('SELECT * FROM app.auth_sessions');expect(cookie(result)).not.toContain(stored!.token_hash);
 });
 it('rejects wrong username/password and cross-origin login without issuing a session',async()=>{
  for(const input of [{...credentials,password:'wrong'}, {...credentials,username:'missing'}]){const result=await login(input);expect(result.statusCode).toBe(401);expect(result.headers['set-cookie']).toBeUndefined();}
  expect((await login(credentials,'https://other.example')).statusCode).toBe(403);
  expect((await login(credentials,'malformed')).statusCode).toBe(403);
  expect((await built.store.one('SELECT count(*) n FROM app.auth_sessions'))!.n).toBe('0');
 });
 it('revokes logged-out, expired and password-reset sessions',async()=>{
  const first=cookie(await login());const logout=await built.server.inject({method:'POST',url:'/api/v2/auth/logout',headers:{cookie:first},payload:{}});
  expect(logout.statusCode).toBe(200);expect(logout.headers['set-cookie']).toContain('Max-Age=0');expect((await get(first)).statusCode).toBe(401);
  const expired=cookie(await login());await built.store.exec("UPDATE app.auth_sessions SET expires_at=now()-interval '1 second'");expect((await get(expired)).statusCode).toBe(401);
  const reset=cookie(await login());await setAdministrator(folder,credentials.username,'Another-synthetic-password');expect((await get(reset)).statusCode).toBe(401);
 });
 it('persists a valid session across API restarts',async()=>{
  const saved=cookie(await login());await built.server.close();built=await buildServer({url,folder,assets:false});expect((await get(saved)).statusCode).toBe(200);
 });
 it('bounds login attempts and recovers after the rate window',async()=>{
  for(let n=0;n<8;n++)expect((await login({...credentials,password:'wrong'})).statusCode).toBe(401);
  expect((await login()).statusCode).toBe(429);
  await built.store.exec("UPDATE app.auth_limits SET started_at=now()-interval '2 minutes'");expect((await login()).statusCode).toBe(200);
 });
});
