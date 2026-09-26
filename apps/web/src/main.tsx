import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient, ApiContext, ApiError, storage, useAction, useData, useEvents } from './api';
import { ErrorNotice, PageBoundary } from './ui';
import { TodayPage, GoalPage, GoalsPage, SessionPage } from './learning';
import type { Today } from '../../../packages/contracts/src/index';
import s from './styles.module.css';

const LibraryPage=lazy(()=>import('./library').then(module=>({default:module.LibraryPage})));
const SourcePage=lazy(()=>import('./library').then(module=>({default:module.SourcePage})));
const HistoryPage=lazy(()=>import('./secondary').then(module=>({default:module.HistoryPage})));
const NotificationsPage=lazy(()=>import('./secondary').then(module=>({default:module.NotificationsPage})));
const SchedulesPage=lazy(()=>import('./secondary').then(module=>({default:module.SchedulesPage})));
const SettingsPage=lazy(()=>import('./secondary').then(module=>({default:module.SettingsPage})));

function useRoute(){const [route,setRoute]=useState(()=>window.location.hash.slice(1)||'/today');useEffect(()=>{const changed=()=>{setRoute(window.location.hash.slice(1)||'/today');window.scrollTo(0,0);};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);return route;}
function App(){
  const [token,setToken]=useState(()=>storage.get('token')||storage.legacyToken());
  const logout=()=>{storage.clear();setToken('');window.location.hash='/today';};
  return token?<Authenticated key={token} token={token} logout={logout}/>:<Login onLogin={value=>{storage.set('token',value);setToken(value);}}/>;
}
function Login({onLogin}:{onLogin:(token:string)=>void}){const [token,setToken]=useState(''),action=useAction(),pending=useRef<ApiClient|null>(null);useEffect(()=>()=>pending.current?.dispose(),[]);const submit=(e:FormEvent)=>{e.preventDefault();const value=token.trim();void action.run(async()=>{const api=new ApiClient(value);pending.current=api;try{await api.get('/today');return value;}finally{api.dispose();pending.current=null;}},onLogin);};return <main className={s.login}><a className={s.brand} href="#/today"><span className={s.logo} aria-hidden="true">学</span>学习助手</a><h1>继续你的学习。</h1><p className={s.muted}>输入访问口令，连接本机助手。</p><form className={s.form} onSubmit={submit}><label>访问口令<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="current-password" autoFocus required/></label><button className={s.primary} disabled={action.busy||!token.trim()}>{action.busy?'正在连接…':'进入'}</button><ErrorNotice error={action.error}/></form><details className={s.disclosure}><summary>在哪里找到口令</summary><p>启动助手时会显示口令文件位置。默认保存在项目的 private/access-token 文件中。</p></details></main>;}
function Authenticated({token,logout}:{token:string;logout:()=>void}){
  const expiration=useRef(logout);expiration.current=logout;
  const api=useMemo(()=>new ApiClient(token),[token]);
  const client=useMemo(()=>new QueryClient({queryCache:new QueryCache({onError:error=>{if(error instanceof ApiError&&error.status===401)expiration.current();}}),defaultOptions:{queries:{retry:(count,error)=>!(error instanceof ApiError&&error.status===401)&&count<1,refetchOnWindowFocus:true}}}),[]);
  useEffect(()=>()=>{api.dispose();client.clear();},[api,client]);
  return <ApiContext.Provider value={api}><QueryClientProvider client={client}><Shell api={api} client={client} logout={logout}/></QueryClientProvider></ApiContext.Provider>;
}
function Shell({api,client,logout}:{api:ApiClient;client:QueryClient;logout:()=>void}){
  const route=useRoute(),connected=useEvents(api,client,logout),today=useData<Today>('/today');
  useEffect(()=>{if(today.data){storage.set('token',api.token);storage.forgetLegacy();}},[today.data,api]);
  const url=new URL(route,'http://assistant.local'),parts=url.pathname.split('/').filter(Boolean);
  let name=parts[0]||'today',id='';name=({learn:'today',plans:'schedules',inbox:'notifications',task:'session'} as Record<string,string>)[name]||name;try{id=decodeURIComponent(parts.slice(1).join('/'));}catch{name='today';}
  const primary=name==='goal'?'goals':name==='source'?'library':name==='session'?'today':name;
  const secondary=[['notifications','消息'+(today.data?.unread?'（'+today.data.unread+'）':'')],['schedules','定时计划'],['history','历史'],['settings','设置']];
  const page=name==='goals'?<GoalsPage/>:name==='goal'&&id?<GoalPage key={id} id={id}/>:name==='session'&&id?<SessionPage key={id} id={id}/>:name==='library'?<LibraryPage/>:name==='source'&&id?<SourcePage key={route} id={id} version={url.searchParams.get('version')||undefined}/>:name==='notifications'?<NotificationsPage/>:name==='schedules'?<SchedulesPage/>:name==='history'?<HistoryPage/>:name==='settings'?<SettingsPage/>:<TodayPage/>;
  return <div className={s.layout}><a href="#main-content" className={s.skip} onClick={event=>{event.preventDefault();const main=document.getElementById('main-content');main?.focus();main?.scrollIntoView();}}>跳到内容</a><aside className={s.sidebar}><a className={s.brand} href="#/today"><span className={s.logo} aria-hidden="true">学</span><span>学习助手</span></a><nav className={s.navigation} aria-label="主导航">{[['today','今天'],['goals','目标'],['library','资料']].map(([path,label])=><a href={'#/'+path} aria-current={primary===path?'page':undefined} className={primary===path?s.activeNav:s.navLink} key={path}>{label}</a>)}</nav><details className={s.more} key={route}><summary>更多{Boolean(today.data?.unread)&&<span className={s.unreadDot} aria-label="有新消息"/>}</summary><div className={s.moreMenu}>{secondary.map(([path,label])=><a key={path} href={'#/'+path} className={name===path?s.activeNav:s.navLink} aria-current={name===path?'page':undefined}>{label}</a>)}<div className={s.connection}><span className={connected?s.online:s.offline}/>{connected?'已连接':'正在重连'}</div><button className={s.textButton} onClick={logout}>退出</button></div></details><p className={s.sidebarNote}>按自己的节奏。</p></aside><main className={s.main} id="main-content" tabIndex={-1} key={name}><PageBoundary key={route}><Suspense fallback={<p className={s.muted} role="status">正在载入…</p>}>{page}</Suspense></PageBoundary></main></div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
