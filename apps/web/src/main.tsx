import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient, ApiContext, ApiError, storage, authRequest, useAction, useData, useEvents } from './api';
import { LiveContext } from './live';
import { ErrorNotice, PageBoundary } from './ui';
import { TodayPage } from './today';
import { GoalPage, GoalsPage } from './goals';
import { SessionPage } from './session';
import type { TodayOverview } from '../../../packages/contracts/src/pagination';
import s from './styles.module.css';
import { Icon, type IconName } from './icons';

const LibraryPage = lazy(() => import('./library').then((module) => ({ default: module.LibraryPage })));
const SourcePage = lazy(() => import('./library').then((module) => ({ default: module.SourcePage })));
const HistoryPage = lazy(() => import('./secondary').then((module) => ({ default: module.HistoryPage })));
const NotificationsPage = lazy(() => import('./secondary').then((module) => ({ default: module.NotificationsPage })));
const SchedulesPage = lazy(() => import('./secondary').then((module) => ({ default: module.SchedulesPage })));
const SettingsPage = lazy(() => import('./secondary').then((module) => ({ default: module.SettingsPage })));

const DevicesPage = lazy(() => import('./devices').then((module) => ({ default: module.DevicesPage })));
const MailPage = lazy(() => import('./mail').then((module) => ({ default: module.MailPage })));
const MailThreadPage = lazy(() => import('./mail').then((module) => ({ default: module.MailThreadPage })));
function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/today');
  useEffect(() => {
    const changed = () => {
      setRoute(window.location.hash.slice(1) || '/today');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return route;
}
function Brand() {
  return (
    <a className={s.brand} href="#/today" aria-label="yeux 学习秘书">
      <span className={s.mascot}>
        <img src="/sardina-secretary.png" alt="戴着圆眼镜、拿着记事本和笔的沙丁鱼秘书" width="1280" height="1280" />
      </span>
      <span>
        <strong>yeux</strong>
        <small className={s.brandLabel}>学习秘书</small>
      </span>
    </a>
  );
}
function App() {
  const [username, setUsername] = useState<string | null>(null),
    [pending, setPending] = useState(true),
    [connectionError, setConnectionError] = useState<Error | null>(null);
  const expired = () => {
    storage.clear();
    setUsername(null);
    window.location.hash = '/today';
  };
  useEffect(() => {
    let alive = true;
    void authRequest('session')
      .then((result) => {
        if (alive) setUsername(result.username);
      })
      .catch((error) => {
        if (alive) {
          if (error instanceof ApiError && error.status === 401) storage.clear();
          else setConnectionError(error);
        }
      })
      .finally(() => {
        if (alive) setPending(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const logout = async () => {
    await authRequest('logout', {});
    expired();
  };
  if (pending)
    return (
      <main className={s.boot}>
        <Brand />
        <p role="status">正在打开你的工作台…</p>
      </main>
    );
  return username ? (
    <Authenticated username={username} logout={logout} expired={expired} />
  ) : (
    <Login
      initialError={connectionError}
      onLogin={(value) => {
        storage.clear();
        setConnectionError(null);
        setUsername(value);
      }}
    />
  );
}
function Login({ onLogin, initialError }: { onLogin: (username: string) => void; initialError: Error | null }) {
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [visible, setVisible] = useState(false),
    action = useAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(
      () => authRequest('login', { username: username.trim(), password }),
      (result) => {
        setPassword('');
        onLogin(result.username);
      },
    );
  };
  return (
    <main className={s.loginLayout}>
      <div className={s.loginFrame}>
        <aside className={s.loginIntro}>
          <Brand />
          <div className={s.loginIntroCopy}>
            <h2>
              让每一次学习，
              <br />
              都有迹可循。
            </h2>
            <p>
              你的目标、资料和练习，
              <br />
              在一个地方接着做。
            </p>
          </div>
          <div className={s.loginFeatures}>
            {(
              [
                ['goals', '目标', '拆成可以完成的下一步'],
                ['library', '资料', '讲义与笔记，随时查阅'],
                ['today', '练习', '记录理解，也留住问题'],
              ] as const
            ).map(([icon, title, description]) => (
              <div key={title}>
                <span>
                  <Icon name={icon} />
                </span>
                <p>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </p>
              </div>
            ))}
          </div>
        </aside>
        <section className={s.loginPanel} aria-labelledby="login-title">
          <div className={s.loginForm}>
            <h1 id="login-title">欢迎回来</h1>
            <p className={s.muted}>登录你的个人学习空间。</p>
            <form className={s.form} onSubmit={submit}>
              <label>
                账号
                <input
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={80}
                  placeholder="输入管理员账号"
                  required
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoFocus
                />
              </label>
              <div>
                <label htmlFor="password">密码</label>
                <div className={s.passwordField}>
                  <input
                    id="password"
                    name="password"
                    type={visible ? 'text' : 'password'}
                    placeholder="输入密码"
                    autoComplete="current-password"
                    maxLength={1024}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <button
                    type="button"
                    className={s.textButton}
                    aria-label={visible ? '隐藏密码' : '显示密码'}
                    aria-pressed={visible}
                    onClick={() => setVisible(!visible)}
                  >
                    {visible ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>
              <ErrorNotice error={action.error || initialError} />
              <button className={s.primary} disabled={action.busy || !username.trim() || !password}>
                {action.busy ? '正在登录…' : '登录'}
                <Icon name="arrow" />
              </button>
            </form>
            <p className={s.loginFootnote}>
              <Icon name="lock" />
              资料与学习记录保存在部署设备
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
function Authenticated({
  username,
  logout,
  expired,
}: {
  username: string;
  logout: () => Promise<void>;
  expired: () => void;
}) {
  const expiration = useRef(expired);
  expiration.current = expired;
  const api = useMemo(() => new ApiClient(''), []);
  const client = useMemo(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error) => {
            if (error instanceof ApiError && error.status === 401) expiration.current();
          },
        }),
        defaultOptions: {
          queries: {
            retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
            refetchOnWindowFocus: true,
          },
        },
      }),
    [],
  );
  useEffect(() => {
    // Warm the Markdown renderer so answers do not flash a loading line.
    void import('react-markdown');
    // The push-only service worker makes the app installable and lets the phone receive notifications.
    if (window.isSecureContext && 'serviceWorker' in navigator)
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  useEffect(
    () => () => {
      api.dispose();
      client.clear();
    },
    [api, client],
  );
  return (
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={client}>
        <Shell api={api} client={client} username={username} logout={logout} expired={expired} />
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}
const sectionNames: Record<string, string> = {
  today: '今天',
  goals: '目标',
  library: '资料',
  devices: '设备',
  mail: '邮件',
  notifications: '消息',
  schedules: '定时计划',
  history: '历史',
  settings: '设置',
};
function greeting(hour = new Date().getHours()) {
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
}
function Shell({
  api,
  client,
  username,
  logout,
  expired,
}: {
  api: ApiClient;
  client: QueryClient;
  username: string;
  logout: () => Promise<void>;
  expired: () => void;
}) {
  const route = useRoute(),
    connected = useEvents(api, client, expired),
    today = useData<TodayOverview>('/today/overview'),
    action = useAction(),
    [menu, setMenu] = useState(false),
    toggle = useRef<HTMLButtonElement>(null);

  const url = new URL(route, 'http://assistant.local'),
    parts = url.pathname.split('/').filter(Boolean);
  let name = parts[0] || 'today',
    id = '';
  name =
    ({ learn: 'today', plans: 'schedules', inbox: 'notifications', task: 'session' } as Record<string, string>)[name] ||
    name;
  try {
    id = decodeURIComponent(parts.slice(1).join('/'));
  } catch {
    name = 'today';
  }
  useEffect(() => setMenu(false), [route]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(false);
      toggle.current?.focus();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menu]);
  const primary = name === 'goal' ? 'goals' : name === 'source' ? 'library' : name === 'session' ? 'today' : name;
  const view = url.searchParams.get('view');
  const unread = today.data?.unread || 0,
    mailBadge = (today.data?.mailWaiting || 0) + (today.data?.mailNew || 0);
  const secondary: Array<[string, string, IconName, boolean]> = [
    ['mail', '邮件' + (mailBadge ? '（' + mailBadge + '）' : ''), 'mail', name === 'mail'],
    ['notifications', '消息' + (unread ? '（' + unread + '）' : ''), 'bell', name === 'notifications'],
    ['devices', '设备', 'device', name === 'devices'],
    ['schedules', '定时计划', 'clock', name === 'schedules'],
    ['history', '历史', 'history', name === 'history'],
    ['settings?view=workspace', '规则与流程', 'branch', name === 'settings' && view === 'workspace'],
    ['settings', '设置', 'gear', name === 'settings' && view !== 'workspace'],
  ];
  const section =
    name === 'session'
      ? '任务记录'
      : name === 'goal'
        ? '目标'
        : name === 'source'
          ? '资料'
          : name === 'settings' && view === 'workspace'
            ? '规则与流程'
            : sectionNames[name] || '今天';
  const page =
    name === 'mail' && id ? (
      <MailThreadPage key={id} id={id} />
    ) : name === 'mail' ? (
      <MailPage />
    ) : name === 'devices' ? (
      <DevicesPage commandId={url.searchParams.get('command') || ''} />
    ) : name === 'goals' ? (
      <GoalsPage />
    ) : name === 'goal' && id ? (
      <GoalPage key={id} id={id} />
    ) : name === 'session' && id ? (
      <SessionPage key={id} id={id} />
    ) : name === 'library' ? (
      <LibraryPage />
    ) : name === 'source' && id ? (
      <SourcePage
        key={route}
        id={id}
        version={url.searchParams.get('version') || undefined}
        start={url.searchParams.get('start') || undefined}
        end={url.searchParams.get('end') || undefined}
      />
    ) : name === 'notifications' ? (
      <NotificationsPage />
    ) : name === 'schedules' ? (
      <SchedulesPage />
    ) : name === 'history' ? (
      <HistoryPage />
    ) : name === 'settings' ? (
      <SettingsPage />
    ) : (
      <TodayPage initialMode={url.searchParams.get('mode')} greeting={greeting() + '，' + username} />
    );
  const now = new Date();
  return (
    <LiveContext.Provider value={connected}>
      <div className={s.layout}>
        <a
          href="#main-content"
          className={s.skip}
          onClick={(event) => {
            event.preventDefault();
            const main = document.getElementById('main-content');
            main?.focus();
            main?.scrollIntoView();
          }}
        >
          跳到内容
        </a>
        <aside className={s.sidebar}>
          <Brand />
          <nav className={s.navigation} aria-label="主导航">
            {(
              [
                ['today', '今天'],
                ['goals', '目标'],
                ['library', '资料'],
              ] as const
            ).map(([path, label]) => (
              <a
                href={'#/' + path}
                aria-current={primary === path ? 'page' : undefined}
                className={primary === path ? s.activeNav : s.navLink}
                key={path}
              >
                <Icon name={path} />
                <span>{label}</span>
              </a>
            ))}
          </nav>
          <button
            ref={toggle}
            type="button"
            className={s.moreToggle}
            aria-label="更多"
            aria-expanded={menu}
            aria-controls="more-panel"
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? 'close' : 'more'} />
            <span>更多</span>
            {unread + mailBadge > 0 && <span className={s.unreadDot} aria-label="有新消息" />}
          </button>
          <div id="more-panel" className={s.morePanel} data-open={menu}>
            <p className={s.navCaption}>更多功能</p>
            <nav className={s.secondaryNav} aria-label="更多功能">
              {secondary.map(([path, label, icon, current]) => (
                <a
                  key={path}
                  href={'#/' + path}
                  className={current ? s.activeNav : s.navLink}
                  aria-current={current ? 'page' : undefined}
                >
                  <Icon name={icon} />
                  <span>{label}</span>
                </a>
              ))}
            </nav>
            <div className={s.account}>
              <span className={s.userAvatar} aria-hidden="true">
                {username.slice(0, 1).toUpperCase()}
              </span>
              <span className={s.accountName}>
                {username}
                <small>
                  <i className={connected ? s.online : s.offline} />
                  管理员<span className={s.accountConnection}> · {connected ? '已连接' : '正在重连'}</span>
                </small>
              </span>
              <button
                type="button"
                className={s.iconButton}
                disabled={action.busy}
                onClick={() => void action.run(logout)}
                title="退出登录"
                aria-label="退出"
              >
                <Icon name="logout" />
                <span>退出</span>
              </button>
            </div>
            <ErrorNotice error={action.error} />
          </div>
        </aside>
        {menu && <div className={s.scrim} aria-hidden="true" onClick={() => setMenu(false)} />}
        <div className={s.workspace}>
          <header className={s.workbar}>
            <a className={s.compactBrand} href="#/today" aria-label="返回今天">
              <span className={s.mascot}>
                <img src="/sardina-secretary.png" alt="" width="1280" height="1280" />
              </span>
              <strong>yeux</strong>
            </a>
            <span className={s.crumb}>{section}</span>
            <div>
              <span className={s.workConnection} title={connected ? '实时更新已连接' : '正在重新连接实时更新'}>
                <i className={connected ? s.online : s.offline} />
                <span>{connected ? '已连接' : '正在重连'}</span>
              </span>
              <time dateTime={now.toISOString().slice(0, 10)}>
                {new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now)}
              </time>
            </div>
          </header>
          <main className={s.main} id="main-content" tabIndex={-1} key={name}>
            <PageBoundary key={route}>
              <Suspense
                fallback={
                  <p className={s.muted} role="status">
                    正在载入…
                  </p>
                }
              >
                {page}
              </Suspense>
            </PageBoundary>
          </main>
        </div>
      </div>
    </LiveContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
