import type { Tx } from '../../storage/src/index.js';
import type { RuntimeStatus } from '../../contracts/src/health.js';

type HealthRow = { name: string; heartbeat: Date | string; error: string };
const components = [
  { name: 'worker', label: '后台执行', staleAfter: 20_000, recovery: '后台连接异常，已保存的任务会等待恢复。' },
  { name: 'scheduler', label: '复习与定时任务', staleAfter: 90_000, recovery: '任务调度未完成，请检查定时计划的设置。' },
  { name: 'knowledge', label: '资料同步', staleAfter: 90_000, recovery: '部分本地资料未能同步，请检查文件格式、大小和读取权限。' },
  { name: 'exports', label: '结果导出', staleAfter: 90_000, recovery: '文件导出未完成，请检查磁盘空间和本地修改；网页中的结果仍保留。' },
  { name: 'devices', label: '设备操作维护', staleAfter: 90_000, recovery: '设备记录维护未完成，请在设备页核对待处理的操作。' },
] as const;

// Only fixed, actionable messages leave this boundary; raw errors may contain private data.
export function runtimeStatus(rows: HealthRow[], now: Date): RuntimeStatus {
  const byName = new Map(rows.map(row => [row.name, row]));
  const values: RuntimeStatus['components'] = components.map(component => {
    const row = byName.get(component.name);
    const timestamp = row ? new Date(row.heartbeat).getTime() : NaN;
    const checkedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    const state = !checkedAt ? 'unknown' : now.getTime() - timestamp > component.staleAfter ? 'stale' : row!.error ? 'error' : 'ok';
    const message = state === 'error' ? component.recovery
      : state === 'stale' ? '最近未收到检查结果，请确认后台仍在运行后刷新。'
      : state === 'unknown' ? '等待后台首次检查。' : '最近检查正常。';
    return { name: component.name, label: component.label, state, checkedAt, message };
  });
  const issueCount = values.filter(value => value.state === 'error' || value.state === 'stale').length;
  return {
    checkedAt: now.toISOString(),
    state: issueCount ? 'degraded' : values.some(value => value.state === 'unknown') ? 'starting' : 'ok',
    issueCount,
    components: values,
  };
}

export async function readRuntimeStatus(tx: Tx): Promise<RuntimeStatus> {
  const rows = await tx.rows<HealthRow>('SELECT name,heartbeat,error FROM app.health WHERE name=ANY($1::text[])', [components.map(component => component.name)]);
  const clock = await tx.one('SELECT clock_timestamp() AS at');
  return runtimeStatus(rows, new Date(clock!.at));
}
