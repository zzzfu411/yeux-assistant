import type { Store } from '../../../storage/src/index.js';
import { WorkspaceCommitInput } from '../../../contracts/src/workspace.js';
import { AppError, digest, once } from '../common.js';
import { Rules } from './rules.js';
import { Flows } from './flows.js';
import { WORKSPACE_LOCK } from './repo.js';

export class Workspace {
  readonly rules: Rules;
  readonly flows: Flows;
  constructor(
    readonly store: Store,
    folder: string,
  ) {
    this.rules = new Rules(store, folder);
    this.flows = new Flows(store, folder);
  }
  async status() {
    const status = await this.rules.repo.status();
    const counts = await this.store.one(
      'SELECT (SELECT count(*) FROM app.memories WHERE path IS NOT NULL) AS rules,(SELECT count(*) FROM app.flows) AS flows',
    );
    return { ...status, rules: Number(counts!.rules), flows: Number(counts!.flows) };
  }
  async scan() {
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      if ((await this.rules.repo.status()).locked)
        throw new AppError('工作区 Git 锁尚未释放，请检查手工 Git 操作。', 409, 'workspace_locked');
      const rules = await this.rules.scanLocked(tx),
        flows = await this.flows.scanLocked(tx);
      return { rules: rules.files, flows: flows.files };
    });
  }
  async commit(key: string, input: unknown) {
    const data = WorkspaceCommitInput.parse(input);
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      return once(tx, key, 'workspace.commit', data, async () => {
        const repo = this.rules.repo,
          replay = await repo.findCommitByTrailer(digest(key));
        if (replay) {
          if (replay.fields['Yeux-Input'] !== digest(data))
            throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict');
          await this.rules.scanLocked(tx);
          await this.flows.scanLocked(tx);
          return { commitSha: replay.hash };
        }
        const status = await repo.status();
        if (status.revision !== data.revision)
          throw new AppError('工作区文件刚被修改，请刷新后重新核对。', 409, 'version_conflict');
        if (!status.changes.length) throw new AppError('工作区没有需要提交的修改。');
        if (status.locked) throw new AppError('工作区有 Git 锁，请先核实手工 Git 操作。', 409, 'workspace_locked');
        const commit = await repo.commitFiles(
          status.changes.map((row) => row.path),
          data.message,
          { 'Yeux-Command': digest(key), 'Yeux-Input': digest(data) },
          true,
        );
        await this.rules.scanLocked(tx);
        await this.flows.scanLocked(tx);
        return { commitSha: commit };
      });
    });
  }
}
