import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CreateAgent,
  agentScopeLabels,
  type AgentScope,
  type AgentCredential,
  type IssuedAgent,
  type AgentAudit,
} from '../../../packages/contracts/src/agents';
import { useAction, useApi, useData } from './api';
import { date, ErrorNotice, Pages, QueryState } from './ui';
import s from './styles.module.css';

const outcomes: Record<AgentAudit['outcome'], string> = {
  started: '处理中或结果待核对',
  succeeded: '已完成',
  failed: '未完成',
  denied: '权限不足',
  limited: '已达额度',
};
const operations: Record<string, string> = {
  get_status: '查看后台状态',
  list_goals: '查看目标',
  get_goal: '读取计划',
  list_tasks: '查看任务',
  get_task: '读取任务',
  list_sources: '查看资料',
  read_source: '阅读资料',
  search_sources: '检索资料',
  create_goal: '创建目标',
  create_task: '准备任务',
  list_devices: '查看设备',
  get_device_command: '读取设备结果',
  request_device_action: '提出设备操作',
};

export function AgentConnectionsPanel() {
  const api = useApi(),
    client = useQueryClient(),
    action = useAction();
  const query = useData<AgentCredential[]>('/agents');
  const [editing, setEditing] = useState(false),
    [issued, setIssued] = useState<IssuedAgent | null>(null);
  const [name, setName] = useState(''),
    [scopes, setScopes] = useState<AgentScope[]>(['workspace:read']);
  const [days, setDays] = useState(30),
    [limit, setLimit] = useState(10),
    [copied, setCopied] = useState(false);
  const endpoint = window.location.origin + '/api/agent/mcp';
  const refresh = () => void client.invalidateQueries({ queryKey: ['/agents'] });
  const save = (event: FormEvent) => {
    event.preventDefault();
    void action.run(
      () =>
        api.write<IssuedAgent>(
          '/agents',
          CreateAgent.parse({ name, scopes, expiresInDays: days, dailyWriteLimit: limit }),
        ),
      (result) => {
        setIssued(result);
        setCopied(false);
        setEditing(false);
        setName('');
        refresh();
      },
    );
  };
  const revoke = (credential: AgentCredential) =>
    void action.run(
      () => api.write('/agents/' + credential.id + '/revoke'),
      () => {
        if (issued?.credential.id === credential.id) setIssued(null);
        action.setMessage(credential.name + ' 的连接已撤销。');
        refresh();
      },
    );
  return (
    <>
      <section className={s.section}>
        <div className={s.sectionHeading}>
          <h2>已授权连接</h2>
          <button className={s.primary} disabled={action.busy || Boolean(issued)} onClick={() => setEditing(!editing)}>
            {editing ? '收起表单' : '添加连接'}
          </button>
        </div>
        <p className={s.muted}>每个 Agent 使用独立令牌。按需开放权限，随时撤销。</p>
        <ErrorNotice error={action.error} />
        {action.message && (
          <p className={s.notice} role="status">
            {action.message}
          </p>
        )}
        {editing && (
          <form className={s.form} onSubmit={save}>
            <label>
              连接名称
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                required
                placeholder="例如 Hermes"
                autoComplete="off"
              />
            </label>
            <fieldset className={s.fieldset}>
              <legend>允许操作</legend>
              {(Object.keys(agentScopeLabels) as AgentScope[]).map((scope) => (
                <label className={s.check} key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [
                              ...new Set([
                                ...current,
                                scope,
                                ...(scope.endsWith(':create')
                                  ? ['workspace:read' as const]
                                  : scope === 'devices:request'
                                    ? ['devices:read' as const]
                                    : []),
                              ]),
                            ]
                          : current.filter(
                              (item) =>
                                item !== scope &&
                                (scope !== 'workspace:read' || !item.endsWith(':create')) &&
                                (scope !== 'devices:read' || item !== 'devices:request'),
                            ),
                      )
                    }
                  />
                  {agentScopeLabels[scope]}
                </label>
              ))}
            </fieldset>
            <p className={s.muted}>
              读取任务包含现有草稿正文；读取资料覆盖整个资料库。创建操作会使用已配置的模型。设备权限覆盖已登记设备，只能提出请求，须由你确认后执行。作答、完成确认和邮件发送仍由你本人处理。
            </p>
            <div className={s.formGrid}>
              <label>
                有效期
                <select aria-label="有效期" value={days} onChange={(event) => setDays(Number(event.target.value))}>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
              {scopes.some((scope) => scope.endsWith(':create') || scope === 'devices:request') && (
                <label>
                  每日写入上限
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={limit}
                    onChange={(event) => setLimit(Number(event.target.value))}
                    required
                  />
                </label>
              )}
            </div>
            <button className={s.primary} disabled={action.busy || !scopes.length}>
              {action.busy ? '正在创建…' : '创建连接'}
            </button>
          </form>
        )}
        {issued && (
          <section className={s.form} aria-label="新连接凭据">
            <h3>{issued.credential.name} 已创建</h3>
            {issued.token ? (
              <>
                <p className={s.muted}>令牌仅本次显示。将它保存到 Agent 的密钥配置，不要粘贴到对话或仓库。</p>
                <label>
                  连接令牌
                  <textarea
                    className={s.agentToken}
                    value={issued.token}
                    readOnly
                    autoFocus
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <div className={s.toolbar}>
                  <button
                    className={s.secondary}
                    onClick={() =>
                      void action.run(
                        () => navigator.clipboard.writeText(issued.token!),
                        () => setCopied(true),
                      )
                    }
                  >
                    {copied ? '已复制令牌' : '复制令牌'}
                  </button>
                  <button className={s.textButton} onClick={() => setIssued(null)}>
                    关闭令牌显示
                  </button>
                </div>
              </>
            ) : (
              <>
                <p role="status">连接已创建，但上次响应未收到。令牌无法再次读取；请撤销此连接后重新创建。</p>
                <button className={s.secondary} disabled={action.busy} onClick={() => revoke(issued.credential)}>
                  撤销此连接
                </button>
              </>
            )}
          </section>
        )}
        <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
        {query.data && (
          <div className={s.rows}>
            {query.data.length ? (
              query.data.map((credential) => (
                <article className={s.row} key={credential.id}>
                  <div>
                    <strong>{credential.name}</strong>
                    <p>{credential.scopes.map((scope) => agentScopeLabels[scope]).join(' · ')}</p>
                    <p>
                      {credential.revokedAt
                        ? '已撤销'
                        : credential.active
                          ? '有效至 ' + date(credential.expiresAt)
                          : '已到期'}
                      {credential.active &&
                      credential.scopes.some((scope) => scope.endsWith(':create') || scope === 'devices:request')
                        ? ` · 今日已写入 ${credential.writesToday}/${credential.dailyWriteLimit}（UTC）`
                        : ''}
                    </p>
                    {credential.lastUsedAt && <p>最近访问 {date(credential.lastUsedAt)}</p>}
                  </div>
                  {credential.active && (
                    <button
                      className={s.textButton}
                      disabled={action.busy}
                      aria-label={'撤销 ' + credential.name}
                      onClick={() => revoke(credential)}
                    >
                      撤销
                    </button>
                  )}
                </article>
              ))
            ) : (
              <p className={s.empty}>还没有外部 Agent 连接。</p>
            )}
          </div>
        )}
      </section>
      <details className={s.section}>
        <summary>连接说明</summary>
        <div className={s.form}>
          <label>
            MCP 地址
            <input readOnly value={endpoint} />
          </label>
          <p className={s.muted}>
            Hermes 等支持远程 MCP 的客户端使用此地址，认证头填写 Authorization: Bearer 加上连接令牌。支持 HTTP
            的客户端可访问 /api/agent/v1/tools。Muse 接入取决于其客户端配置与连接器审核。
          </p>
          <p className={s.muted}>
            每分钟最多 60 次请求；创建操作返回任务编号，完成后再读取结果。写入重试复用同一个 requestKey。
          </p>
        </div>
      </details>
      <AgentActivity />
    </>
  );
}
function AgentActivity() {
  const [page, setPage] = useState(0),
    query = useData<{ items: AgentAudit[]; total: number }>('/agents/audit?page=' + page);
  return (
    <section className={s.section}>
      <div className={s.sectionHeading}>
        <h2>操作记录</h2>
        <button className={s.textButton} disabled={query.isFetching} onClick={() => void query.refetch()}>
          刷新记录
        </button>
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          <div className={s.rows}>
            {query.data.items.length ? (
              query.data.items.map((item) => (
                <article className={s.row} key={item.id}>
                  <div>
                    <strong>
                      {item.agentName} · {operations[item.operation] || item.operation}
                    </strong>
                    <p>
                      {date(item.createdAt)} · {outcomes[item.outcome]}
                    </p>
                  </div>
                </article>
              ))
            ) : (
              <p className={s.empty}>工具调用会记录在这里。</p>
            )}
          </div>
          <Pages page={page} total={query.data.total} onChange={setPage} />
        </>
      )}
    </section>
  );
}
