import { useQuery } from '@tanstack/react-query';
import { RuntimeStatus } from '../../../packages/contracts/src/health';
import { useApi } from './api';
import { date, QueryState } from './ui';
import s from './styles.module.css';

const labels = { ok: '正常', error: '需要处理', stale: '检查已过期', unknown: '等待检查' };
const links = { worker: '', scheduler: '/schedules', knowledge: '/library', exports: '/history', devices: '/devices' };

export function RuntimeStatusPanel() {
  const api = useApi();
  const query = useQuery({
    queryKey: ['/status'],
    queryFn: async ({ signal }) => RuntimeStatus.parse(await api.get('/status', signal)),
    refetchInterval: 20_000,
    retry: 1,
  });
  return (
    <section className={s.section} aria-labelledby="runtime-status-heading">
      <div className={s.sectionHeading}>
        <h2 id="runtime-status-heading">运行状态</h2>
        <button type="button" className={s.textButton} disabled={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? '正在检查…' : '刷新状态'}
        </button>
      </div>
      <QueryState pending={query.isPending} error={query.error} retry={() => void query.refetch()} />
      {query.data && (
        <>
          <p className={s.muted} role="status" aria-label="后台检查状态">
            {query.data.state === 'ok'
              ? '后台检查正常。'
              : query.data.state === 'starting'
                ? '后台尚未完成全部检查。'
                : `${query.data.issueCount} 项需要处理。`}
          </p>
          <div className={s.rows}>
            {query.data.components.map((component) => (
              <div className={s.row} key={component.name}>
                <div>
                  <strong>
                    {component.label} · {labels[component.state]}
                  </strong>
                  <p>{component.message}</p>
                  {component.checkedAt && <p className={s.muted}>最近检查：{date(component.checkedAt)}</p>}
                </div>
                {component.state !== 'ok' && links[component.name] && (
                  <a className={`${s.textLink} ${s.statusLink}`} href={'#' + links[component.name]}>
                    查看
                  </a>
                )}
              </div>
            ))}
          </div>
          <p className={s.muted}>页面打开时每 20 秒更新。设备休眠或后台停止期间，任务会等待恢复。</p>
        </>
      )}
    </section>
  );
}
