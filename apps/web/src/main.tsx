import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient, ApiContext, ApiError, storage, authRequest, useAction, useData, useEvents } from './api';
import { ErrorNotice, PageBoundary } from './ui';
import { TodayPage, GoalPage, GoalsPage, SessionPage } from './learning';
import type { TodayOverview } from '../../../packages/contracts/src/pagination';
import s from './styles.module.css';
import { Icon } from './icons';

const LibraryPage=lazy(()=>import('./library').then(module=>({default:module.LibraryPage})));
const SourcePage=lazy(()=>import('./library').then(module=>({default:module.SourcePage})));
const HistoryPage=lazy(()=>import('./secondary').then(module=>({default:module.HistoryPage})));
const NotificationsPage=lazy(()=>import('./secondary').then(module=>({default:module.NotificationsPage})));
const SchedulesPage=lazy(()=>import('./secondary').then(module=>({default:module.SchedulesPage})));
const SettingsPage=lazy(()=>import('./secondary').then(module=>({default:module.SettingsPage})));

const DevicesPage=lazy(()=>import('./devices').then(module=>({default:module.DevicesPage})));
function useRoute(){const [route,setRoute]=useState(()=>window.location.hash.slice(1)||'/today');useEffect(()=>{const changed=()=>{setRoute(window.location.hash.slice(1)||'/today');window.scrollTo(0,0);};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);return route;}
function Brand(){return <a className={s.brand} href="#/today" aria-label="yeux 学习秘书"><span className={s.mascot}><img src="/sardina-secretary.png" alt="戴着圆眼镜、拿着记事本和笔的沙丁鱼秘书" width="1280" height="1280"/></span><span><strong>yeux</strong><small className={s.brandLabel}>学习秘书</small></span></a>;}
function App(){
  const [username,setUsername]=useState<string|null>(null),[pending,setPending]=useState(true),[connectionError,setConnectionError]=useState<Error|null>(null);
  const expired=()=>{storage.clear();setUsername(null);window.location.hash='/today';};
  useEffect(()=>{let alive=true;void authRequest('session').then(result=>{if(alive)setUsername(result.username);}).catch(error=>{if(alive){if(error instanceof ApiError&&error.status===401)storage.clear();else setConnectionError(error);}}).finally(()=>{if(alive)setPending(false);});return()=>{alive=false;};},[]);
  const logout=async()=>{await authRequest('logout',{});expired();};
  if(pending)return <main className={s.boot}><Brand/><p role="status">正在打开你的工作台…</p></main>;
  return username?<Authenticated username={username} logout={logout} expired={expired}/>:<Login initialError={connectionError} onLogin={value=>{storage.clear();setConnectionError(null);setUsername(value);}}/>;
}
function Login({onLogin,initialError}:{onLogin:(username:string)=>void;initialError:Error|null}){
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[visible,setVisible]=useState(false),action=useAction();
  const submit=(event:FormEvent)=>{event.preventDefault();void action.run(()=>authRequest('login',{username:username.trim(),password}),result=>{setPassword('');onLogin(result.username);});};
  return <main className={s.loginLayout}>
    <div className={s.loginFrame}>
      <aside className={s.loginIntro}><Brand/><div className={s.loginIntroCopy}><h2>让每一次学习，<br/>都有迹可循。</h2><p>你的目标、资料和练习，<br/>在一个地方接着做。</p></div>
        <div className={s.loginFeatures}>{([['goals','目标','拆成可以完成的下一步'],['library','资料','讲义与笔记，随时查阅'],['today','练习','记录理解，也留住问题']] as const).map(([icon,title,description])=><div key={title}><span><Icon name={icon}/></span><p><strong>{title}</strong><small>{description}</small></p></div>)}</div>
      </aside>
      <section className={s.loginPanel} aria-labelledby="login-title"><div className={s.loginForm}><h1 id="login-title">欢迎回来</h1><p className={s.muted}>登录你的个人学习空间。</p><form className={s.form} onSubmit={submit}>
        <label>账号<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={80} placeholder="输入管理员账号" required value={username} onChange={event=>setUsername(event.target.value)} autoFocus/></label>
        <div><label htmlFor="password">密码</label><div className={s.passwordField}><input id="password" name="password" type={visible?'text':'password'} placeholder="输入密码" autoComplete="current-password" maxLength={1024} required value={password} onChange={event=>setPassword(event.target.value)}/><button type="button" className={s.textButton} aria-label={visible?'隐藏密码':'显示密码'} aria-pressed={visible} onClick={()=>setVisible(!visible)}>{visible?'隐藏':'显示'}</button></div></div>
        <ErrorNotice error={action.error||initialError}/><button className={s.primary} disabled={action.busy||!username.trim()||!password}>{action.busy?'正在登录…':'登录'}<Icon name="arrow"/></button>
      </form><p className={s.loginFootnote}><Icon name="lock"/>资料与学习记录保存在部署设备</p></div></section>
    </div>
  </main>;

}
function Authenticated({username,logout,expired}:{username:string;logout:()=>Promise<void>;expired:()=>void}){
  const expiration=useRef(expired);expiration.current=expired;
  const api=useMemo(()=>new ApiClient(''),[]);
  const client=useMemo(()=>new QueryClient({queryCache:new QueryCache({onError:error=>{if(error instanceof ApiError&&error.status===401)expiration.current();}}),defaultOptions:{queries:{retry:(count,error)=>!(error instanceof ApiError&&error.status===401)&&count<1,refetchOnWindowFocus:true}}}),[]);
  useEffect(()=>()=>{api.dispose();client.clear();},[api,client]);
  return <ApiContext.Provider value={api}><QueryClientProvider client={client}><Shell api={api} client={client} username={username} logout={logout} expired={expired}/></QueryClientProvider></ApiContext.Provider>;
}
function Shell({api,client,username,logout,expired}:{api:ApiClient;client:QueryClient;username:string;logout:()=>Promise<void>;expired:()=>void}){
  const route=useRoute(),connected=useEvents(api,client,expired),today=useData<TodayOverview>('/today/overview'),action=useAction();

  const url=new URL(route,'http://assistant.local'),parts=url.pathname.split('/').filter(Boolean);
  let name=parts[0]||'today',id='';name=({learn:'today',plans:'schedules',inbox:'notifications',task:'session'} as Record<string,string>)[name]||name;try{id=decodeURIComponent(parts.slice(1).join('/'));}catch{name='today';}
  const primary=name==='goal'?'goals':name==='source'?'library':name==='session'?'today':name;
  const secondary=[['devices','设备'],['notifications','消息'+(today.data?.unread?'（'+today.data.unread+'）':'')],['schedules','定时计划'],['history','历史'],['settings','设置']];
  const page=name==='devices'?<DevicesPage commandId={url.searchParams.get('command')||''}/>:name==='goals'?<GoalsPage/>:name==='goal'&&id?<GoalPage key={id} id={id}/>:name==='session'&&id?<SessionPage key={id} id={id}/>:name==='library'?<LibraryPage/>:name==='source'&&id?<SourcePage key={route} id={id} version={url.searchParams.get('version')||undefined}/>:name==='notifications'?<NotificationsPage/>:name==='schedules'?<SchedulesPage/>:name==='history'?<HistoryPage/>:name==='settings'?<SettingsPage/>:<TodayPage initialMode={url.searchParams.get('mode')}/>;
  return <div className={s.layout}><a href="#main-content" className={s.skip} onClick={event=>{event.preventDefault();const main=document.getElementById('main-content');main?.focus();main?.scrollIntoView();}}>跳到内容</a><aside className={s.sidebar}><Brand/><nav className={s.navigation} aria-label="主导航">{([['today','今天'],['goals','目标'],['library','资料']] as const).map(([path,label])=><a href={'#/'+path} aria-current={primary===path?'page':undefined} className={primary===path?s.activeNav:s.navLink} key={path}><Icon name={path}/>{label}</a>)}</nav><details className={s.more} key={route}><summary aria-label="更多"><span className={s.userAvatar} aria-hidden="true">{username.slice(0,1).toUpperCase()}</span><span className={s.moreLabel}>更多<small>{username}</small></span><Icon name="more"/>{Boolean(today.data?.unread)&&<span className={s.unreadDot} aria-label="有新消息"/>}</summary><div className={s.moreMenu}>{secondary.map(([path,label])=><a key={path} href={'#/'+path} className={name===path?s.activeNav:s.navLink} aria-current={name===path?'page':undefined}>{label}</a>)}<div className={s.connection}><span className={connected?s.online:s.offline}/>{connected?'已连接':'正在重连'}</div><div className={s.account}>{username}<span>管理员</span></div><button className={s.textButton} disabled={action.busy} onClick={()=>void action.run(logout)}>退出</button><ErrorNotice error={action.error}/></div></details></aside><div className={s.workspace}><header className={s.workbar}><span>个人学习空间</span><div><span className={s.workConnection}><i className={connected?s.online:s.offline}/>{connected?'已连接':'正在重连'}</span><time>{new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date())}</time></div></header><main className={s.main} id="main-content" tabIndex={-1} key={name}><PageBoundary key={route}><Suspense fallback={<p className={s.muted} role="status">正在载入…</p>}>{page}</Suspense></PageBoundary></main></div></div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
