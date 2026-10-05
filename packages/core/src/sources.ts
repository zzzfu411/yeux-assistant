import type { Store, Tx } from '../../storage/src/index.js';
import type { SourceDetail, SourceMetadata } from '../../contracts/src/index.js';
import { SourceArchiveInput, SourceInput, SourceUpdateInput } from '../../contracts/src/source-inputs.js';
import { AppError, checkVersion, event, iso, requireRow } from './common.js';
import { Knowledge, putSource } from './knowledge.js';

/** Source lifecycle operations share the same lock as scanners and importers. */
export class Sources {
  constructor(
    readonly store: Store,
    readonly knowledge: Knowledge,
  ) {}

  async list(archived = false) {
    const rows = await this.store.rows(
      `SELECT s.id,s.title,s.version,s.revision,s.digest,s.updated_at,s.archived_at,s.managed,
      CASE WHEN v.metadata IS NULL THEN NULL ELSE jsonb_build_object('course',v.metadata->'course','courseName',v.metadata->'courseName','format',v.metadata->'format') END AS metadata
      FROM app.sources s JOIN app.source_versions v ON v.source_id=s.id AND v.version=s.version
      WHERE (s.archived_at IS NOT NULL)=$1 ORDER BY s.updated_at DESC,s.id`,
      [archived],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      version: r.version,
      revision: r.revision,
      digest: r.digest,
      updatedAt: iso(r.updated_at),
      archivedAt: r.archived_at ? iso(r.archived_at) : null,
      managed: r.managed,
      metadata: r.metadata,
    }));
  }

  async detail(sourceId: string, version?: number): Promise<SourceDetail> {
    return this.store.snapshot(async (tx) => {
      const source = await requireRow(
        tx,
        `SELECT s.id,v.title,v.version,v.content,v.digest,v.metadata,s.version AS current_version,
        s.revision,s.archived_at,s.managed,current.metadata AS current_metadata
        FROM app.sources s JOIN app.source_versions v ON s.id=v.source_id
        JOIN app.source_versions current ON current.source_id=s.id AND current.version=s.version
        WHERE s.id=$1 AND v.version=coalesce($2,s.version)`,
        [sourceId, version ?? null],
      );
      const versions = (
        await tx.rows(
          'SELECT version,title,created_at FROM app.source_versions WHERE source_id=$1 ORDER BY version DESC',
          [sourceId],
        )
      ).map((row) => ({ version: Number(row.version), title: String(row.title), createdAt: iso(row.created_at) }));
      return {
        id: String(source.id),
        title: String(source.title),
        version: Number(source.version),
        content: String(source.content),
        digest: String(source.digest),
        metadata: source.metadata as SourceMetadata | null,
        current_version: Number(source.current_version),
        revision: Number(source.revision),
        managed: Boolean(source.managed),
        archivedAt: source.archived_at ? iso(source.archived_at) : null,
        editableText: Boolean(source.managed && source.current_metadata === null),
        versions,
      };
    });
  }

  import(tx: Tx, key: string, input: unknown) {
    const data = SourceInput.parse(input);
    return this.knowledge.import(tx, key, data.title, data.content, data.allowDuplicate);
  }

  async update(tx: Tx, sourceId: string, input: unknown) {
    const data = SourceUpdateInput.parse(input);
    await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + sourceId]);
    const old = await requireRow(tx, 'SELECT * FROM app.sources WHERE id=$1 FOR UPDATE', [sourceId]);
    checkVersion(old, data.revision);
    if (old.archived_at) throw new AppError('请先恢复这份资料，再修改内容。', 409, 'source_archived');
    const current = await requireRow(
      tx,
      'SELECT content,metadata FROM app.source_versions WHERE source_id=$1 AND version=$2',
      [sourceId, old.version],
    );
    if (data.content !== undefined && data.content !== current.content && (!old.managed || current.metadata !== null)) {
      throw new AppError('这份资料来自外部原件，请通过原导入流程更新正文；标题仍可修改。', 409, 'source_read_only');
    }
    const result = await putSource(tx, {
      id: sourceId,
      title: data.title ?? old.title,
      content: data.content ?? current.content,
    });
    const revision = (await tx.one('SELECT revision FROM app.sources WHERE id=$1', [sourceId]))!.revision;
    return { ...result, revision };
  }

  async archive(tx: Tx, sourceId: string, input: unknown) {
    const data = SourceArchiveInput.parse(input);
    await tx.exec('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['source-id:' + sourceId]);
    const old = await requireRow(tx, 'SELECT * FROM app.sources WHERE id=$1 FOR UPDATE', [sourceId]);
    checkVersion(old, data.revision);
    if (Boolean(old.archived_at) !== data.archived) {
      await tx.exec(
        'UPDATE app.sources SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END,revision=revision+1,updated_at=now() WHERE id=$1',
        [sourceId, data.archived],
      );
      await event(tx, data.archived ? 'source.archived' : 'source.restored', sourceId);
    }
    const row = (await tx.one('SELECT revision,archived_at FROM app.sources WHERE id=$1', [sourceId]))!;
    return { id: sourceId, revision: row.revision, archivedAt: row.archived_at ? iso(row.archived_at) : null };
  }
}
