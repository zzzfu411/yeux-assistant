import type { Row, Tx } from '../../../storage/src/index.js';
import { EhallState, EhallPrepare, EhallSubmit, ehallArguments, ehallProfile } from '../../../contracts/src/ehall.js';
import { AppError, canonical, id } from '../common.js';
import { putSource } from '../knowledge.js';
import { BridgeTransport } from './bridge.js';
import { DeviceNotApplied, type Capability, type DeviceAdapter, type ExecutionContext } from './driver.js';

export class BridgedEhall extends BridgeTransport implements DeviceAdapter {
  readonly id = 'browser.ehall';
  readonly version = '1';
  readonly mode = 'simulation' as const;
  readonly capabilities: Capability[] = Object.entries(ehallArguments).map(([id, schema]) => ({
    id,
    version: '1',
    schema,
    timeoutMs: id === 'ehall.form.prepare' ? 120000 : 60000,
    label: (
      {
        'ehall.session.check': '检查模拟登录',
        'ehall.query': '查询模拟课表',
        'ehall.form.prepare': '准备模拟表单',
        'ehall.form.submit': '提交模拟申请',
      } as Record<string, string>
    )[id]!,
    choices: id.includes('form.')
      ? []
      : [
          {
            label: id === 'ehall.query' ? '查询模拟课表' : '检查模拟登录',
            arguments: { profile: ehallProfile.id, profileVersion: '1' },
          },
        ],
    summary: (input) => {
      const name =
        id === 'ehall.query'
          ? '查询模拟课表'
          : id === 'ehall.session.check'
            ? '检查模拟登录'
            : id === 'ehall.form.prepare'
              ? '准备模拟在读证明'
              : '提交模拟在读证明';
      const form = EhallPrepare.safeParse(input);
      const submission = EhallSubmit.safeParse(input);
      const fields = form.success ? form.data.fields : submission.success ? submission.data.fields : null;
      return fields
        ? name +
            ' · 申请人：' +
            fields.applicant +
            '；用途：' +
            fields.purpose +
            '（本人填写）。' +
            ehallProfile.consequences
        : name;
    },
    matches: (input, value) => {
      const parsed = EhallState.safeParse(value);
      if (!parsed.success) return false;
      const state = parsed.data;
      if (id === 'ehall.session.check') return state.phase === 'session';
      if (!state.loggedIn) return false;
      if (id === 'ehall.query') return state.phase === 'query' && Boolean(state.rows);
      if (id === 'ehall.form.prepare')
        return (
          state.phase === 'form' && Boolean(state.formDigest) && canonical(state.fields) === canonical(input.fields)
        );
      return state.phase === 'status' && state.application?.formDigest === input.formDigest;
    },
  }));
  async validateCommand(tx: Tx, deviceId: string, capability: string, input: Record<string, unknown>) {
    if (capability !== 'ehall.form.submit') return;
    const data = EhallSubmit.parse(input);
    const prepared = await tx.one(
      "SELECT * FROM app.device_commands WHERE id=$1 AND device_id=$2 AND state='succeeded' AND payload->>'capability'='ehall.form.prepare'",
      [data.preparedCommandId, deviceId],
    );
    const state = EhallState.safeParse(prepared?.receipt?.after);
    if (
      !state.success ||
      state.data.formDigest !== data.formDigest ||
      state.data.screenshotDigest !== data.screenshotDigest ||
      canonical(state.data.fields) !== canonical(data.fields) ||
      prepared!.payload.adapterVersion !== this.version ||
      canonical(prepared!.payload.arguments.sources) !== canonical(data.sources)
    )
      throw new AppError('预览与已核验表单不一致，请重新准备。', 409, 'ehall_preview_changed');
    // A successful or uncertain submit must not be repeated from the same preparation.
    if (
      await tx.one(
        "SELECT id FROM app.device_commands WHERE device_id=$1 AND payload->>'capability'='ehall.form.submit' AND payload->'arguments'->>'preparedCommandId'=$2 AND state IN ('succeeded','uncertain','resolved')",
        [deviceId, data.preparedCommandId],
      )
    )
      throw new AppError('这份表单已有提交记录，请先核实结果，不要重复提交。', 409, 'ehall_already_submitted');
  }
  async readState(deviceId: string, signal: AbortSignal, context?: ExecutionContext) {
    if (!context) throw new DeviceNotApplied('Missing bounded execution context');
    const result = await this.rpc(deviceId, 'read', { ...context, signal });
    if (!result.ok)
      throw new DeviceNotApplied(
        result.effect === 'login_required' ? '请在模拟执行器窗口登录。' : '无法核验模拟页面。',
      );
    return EhallState.parse(result.state);
  }
  async execute(deviceId: string, _capability: string, _input: Record<string, unknown>, context: ExecutionContext) {
    const result = await this.rpc(deviceId, 'execute', context);
    if (!result.ok) {
      if (result.effect !== 'unknown')
        throw new DeviceNotApplied(
          result.effect === 'login_required'
            ? '请在模拟执行器窗口登录。'
            : '页面或字段发生变化，操作未提交，请重新准备。',
        );
      throw new Error('提交结果待核实');
    }
  }
  async record(tx: Tx, command: Row, after: Record<string, unknown>) {
    if (command.payload.capability !== 'ehall.query') return;
    const state = EhallState.parse(after),
      path = 'ehall/' + command.device_id + '/timetable';
    const old = await tx.one('SELECT id FROM app.sources WHERE path=$1', [path]);
    const escape = (s: string) => s.replace(/[|\r\n]/g, ' ');
    await putSource(tx, {
      id: old?.id || id(),
      path,
      managed: true,
      title: 'ehall · 模拟课表',
      content:
        '# 模拟课表\n\n仅用于 Lab1 模拟验收，不是本人真实课表。\n\n配置：' +
        ehallProfile.id +
        ' v1\n\n查询时间：' +
        new Date().toISOString() +
        '\n\n执行记录：' +
        command.id +
        '\n\n截图摘要：' +
        state.screenshotDigest +
        '\n\n| 课程 | 时间 |\n| --- | --- |\n' +
        state.rows!.map((row) => '| ' + escape(row.course) + ' | ' + escape(row.time) + ' |').join('\n'),
    });
  }
}
