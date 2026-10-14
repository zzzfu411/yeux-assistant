import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store, Tx } from '../../../storage/src/index.js';
import { MemoryInput } from '../../../contracts/src/index.js';
import { RuleHeader } from '../../../contracts/src/workspace.js';
import { AppError, digest, event, notify, once } from '../common.js';
import { WorkspaceRepo, WORKSPACE_LOCK } from './repo.js';
import { files, formatFile, parseFile, rulePath } from './files.js';

type Rule = ReturnType<typeof MemoryInput.parse>;
export class Rules {
  readonly repo: WorkspaceRepo;
  constructor(
    readonly store: Store,
    folder: string,
  ) {
    this.repo = new WorkspaceRepo(folder);
  }
  async persist(
    tx: Tx,
    data: Rule,
    options: { path: string | null; hash: string | null; commit: string | null; origin: string },
    version = data.revision + 1,
  ) {
    await tx.exec(
      `INSERT INTO app.memories(key,scope,content,version,confirmed,enabled,path,file_digest,commit_sha,origin)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(key) DO UPDATE SET scope=excluded.scope,content=excluded.content,version=excluded.version,confirmed=excluded.confirmed,enabled=excluded.enabled,path=excluded.path,file_digest=excluded.file_digest,commit_sha=excluded.commit_sha,origin=excluded.origin,updated_at=now()`,
      [
        data.key,
        data.scope,
        data.content,
        version,
        data.confirmed,
        data.enabled,
        options.path,
        options.hash,
        options.commit,
        options.origin,
      ],
    );
    await tx.exec('INSERT INTO app.memory_versions(key,version,snapshot,commit_sha) VALUES($1,$2,$3,$4)', [
      data.key,
      version,
      JSON.stringify({ ...data, version, path: options.path, origin: options.origin }),
      options.commit,
    ]);
    await event(tx, 'memory.updated', data.key);
    return { key: data.key, version, commitSha: options.commit };
  }
  async save(key: string, input: unknown) {
    const data = MemoryInput.parse(input);
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      return once(tx, key, 'memory.save', data, async () => {
        const old = await tx.one('SELECT * FROM app.memories WHERE key=$1 FOR UPDATE', [data.key]);
        const recovered = await this.repo.findCommitByTrailer(digest(key));
        if (recovered) {
          if (recovered.fields['Yeux-Input'] !== digest(data))
            throw new AppError('同一请求标识不能用于不同内容。', 409, 'idempotency_conflict');
          const path = recovered.fields['Yeux-Path']!,
            text = await this.repo.show(recovered.hash, path),
            parsed = parseFile(text, RuleHeader);
          if (parsed.header.key !== data.key || parsed.content !== data.content)
            throw new AppError('规则提交回执与请求不一致。', 409, 'workspace_receipt');
          // A scan or a later edit may already have advanced the index. Never overwrite it with an old retry.
          if (!old || old.version <= data.revision)
            await this.persist(tx, data, { path, hash: digest(text), commit: recovered.hash, origin: 'web' });
          return { key: data.key, version: data.revision + 1, commitSha: recovered.hash };
        }
        if ((old?.version || 0) !== data.revision)
          throw new AppError('规则已修改，请载入最新版本。', 409, 'version_conflict');
        if (old?.path && !data.confirmed) throw new AppError('已确认的文件规则请停用；不能改回未经确认的提议。');
        if (!data.confirmed) return this.persist(tx, data, { path: null, hash: null, commit: null, origin: 'web' });
        const status = await this.repo.status();
        if (status.locked)
          throw new AppError('工作区有 Git 锁，请先完成或核实手工 Git 操作。', 409, 'workspace_locked');
        const path = old?.path || rulePath(data.scope, data.key);
        let created = new Date().toISOString().slice(0, 10);
        try {
          const current = await this.repo.read(path);
          if (!old?.path || digest(current) !== old.file_digest)
            throw new AppError('规则文件有尚未载入的修改，请刷新工作区后重试。', 409, 'workspace_changed');
          const header = parseFile(current, RuleHeader).header;
          if (header.key !== data.key) throw new AppError('规则标识与文件内容不一致。', 409, 'workspace_changed');
          created = header.created;
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
          if (old?.file_digest) throw new AppError('规则文件已移除，请先刷新工作区。', 409, 'workspace_changed');
        }
        const text = formatFile({ key: data.key, scope: data.scope, enabled: data.enabled, created }, data.content);
        // Check the index before writing; a staged user change must not be consumed by this save.
        if (status.changes.some((change) => change.status[0] !== ' ' && change.status !== '??'))
          throw new AppError('工作区已有暂存修改，请先手工处理。', 409, 'workspace_staged');
        await this.repo.write(path, text);
        const commit = await this.repo.commitFiles(
          [path],
          `rule: ${data.key.replace(/[\x00-\x1f\x7f]/g, ' ')} v${data.revision + 1}`,
          { 'Yeux-Command': digest(key), 'Yeux-Input': digest(data), 'Yeux-Path': path },
        );
        return this.persist(tx, data, { path, hash: digest(text), commit, origin: 'web' });
      });
    });
  }
  async scan() {
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      return this.scanLocked(tx);
    });
  }
  async scanLocked(tx: Tx) {
    const names = await files(this.repo, 'rules'),
      present = new Set(names),
      entries: Array<{
        path: string;
        text: string;
        data: ReturnType<typeof parseFile<ReturnType<typeof RuleHeader.parse>>>;
      }> = [];
    for (const path of names) {
      try {
        const text = await this.repo.read(path),
          data = parseFile(text, RuleHeader);
        if (!data.content) throw new AppError('规则正文不能为空。');
        entries.push({ path, text, data });
      } catch (error) {
        const info = await lstat(join(this.repo.root, path));
        await notify(
          tx,
          'rule-invalid:' + digest(path + info.mtimeMs + info.size),
          null,
          '规则文件格式错误',
          path + '；保留上一个有效版本。',
        );
      }
    }
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.data.header.key, (counts.get(entry.data.header.key) || 0) + 1);
    for (const { path, text, data } of entries) {
      const old = await tx.one('SELECT * FROM app.memories WHERE key=$1 FOR UPDATE', [data.header.key]);
      const conflict =
        counts.get(data.header.key)! > 1 || Boolean(old?.path && old.path !== path && present.has(old.path));
      if (conflict) {
        if (old?.enabled)
          await this.persist(
            tx,
            {
              key: old.key,
              scope: old.scope,
              content: old.content,
              confirmed: old.confirmed,
              enabled: false,
              revision: old.version,
            },
            { path: old.path, hash: null, commit: old.commit_sha, origin: 'file_edit' },
          );
        await notify(
          tx,
          'rule-conflict:' + digest(data.header.key + names.join('\n')),
          null,
          '规则标识重复，已暂停使用',
          data.header.key + '；请保留一个有效文件。',
        );
        continue;
      }
      const latest = (await this.repo.log(path, 1))[0] || null;
      const commit = latest && (await this.repo.show(latest, path).catch(() => null)) === text ? latest : null;
      if (old?.file_digest === digest(text) && old.path === path) {
        if (old.commit_sha !== commit) {
          await tx.exec('UPDATE app.memories SET commit_sha=$2 WHERE key=$1', [old.key, commit]);
          await tx.exec('UPDATE app.memory_versions SET commit_sha=$3 WHERE key=$1 AND version=$2', [
            old.key,
            old.version,
            commit,
          ]);
        }
        continue;
      }
      await this.persist(
        tx,
        {
          key: data.header.key,
          scope: data.header.scope,
          content: data.content,
          confirmed: true,
          enabled: data.header.enabled,
          revision: old?.version || 0,
        },
        { path, hash: digest(text), commit, origin: 'file_edit' },
      );
    }
    for (const old of await tx.rows('SELECT * FROM app.memories WHERE path IS NOT NULL AND enabled FOR UPDATE')) {
      if (present.has(old.path)) continue;
      await this.persist(
        tx,
        {
          key: old.key,
          scope: old.scope,
          content: old.content,
          confirmed: true,
          enabled: false,
          revision: old.version,
        },
        { path: old.path, hash: null, commit: old.commit_sha, origin: 'file_edit' },
      );
      await notify(tx, 'rule-missing:' + digest(old.path + old.version), null, '规则文件已移除，已停用', old.path);
    }
    return { files: names.length };
  }
  async importExisting(apply = false) {
    return this.store.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock($1)', [WORKSPACE_LOCK]);
      const rows = await tx.rows('SELECT * FROM app.memories WHERE confirmed AND path IS NULL ORDER BY key FOR UPDATE');
      const planned = rows.map((row) => ({ key: row.key, path: rulePath(row.scope, row.key) }));
      if (!apply || !rows.length) return { applied: false, files: planned };
      if ((await this.repo.status()).changes.length)
        throw new AppError('请先提交或处理工作区的手工修改，再导入旧规则。', 409);
      const texts = rows.map((row) => ({
        path: rulePath(row.scope, row.key),
        text: formatFile(
          {
            key: row.key,
            scope: row.scope,
            enabled: row.enabled,
            created: new Date(row.updated_at).toISOString().slice(0, 10),
          },
          row.content,
        ),
        version: row.version,
      }));
      const command = digest({ operation: 'import-existing-rules', texts });
      const recovered = await this.repo.findCommitByTrailer(command);
      if (recovered) {
        for (const file of texts)
          if (
            (await this.repo.show(recovered.hash, file.path)) !== file.text ||
            (await this.repo.read(file.path)) !== file.text
          )
            throw new AppError('旧规则提交后文件已变化，请先载入并核对工作区。', 409);
      } else {
        for (const file of texts) {
          try {
            await this.repo.read(file.path);
            throw new AppError('工作区已存在同名规则，导入不会覆盖。', 409);
          } catch (error: any) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        for (const file of texts) await this.repo.write(file.path, file.text);
      }
      const commit =
        recovered?.hash ||
        (await this.repo.commitFiles(
          planned.map((item) => item.path),
          'workspace: import existing rules',
          { 'Yeux-Command': command },
        ));
      for (const row of rows) {
        const path = rulePath(row.scope, row.key);
        await tx.exec("UPDATE app.memories SET path=$2,file_digest=$3,commit_sha=$4,origin='import' WHERE key=$1", [
          row.key,
          path,
          digest(await this.repo.read(path)),
          commit,
        ]);
        await tx.exec('UPDATE app.memory_versions SET commit_sha=$3 WHERE key=$1 AND version=$2', [
          row.key,
          row.version,
          commit,
        ]);
      }
      return { applied: true, files: planned, commitSha: commit };
    });
  }
}
