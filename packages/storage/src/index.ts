import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Registered, reviewed migrations only; never resolve database or user-supplied paths.
const migrations = [
  { version: 1, file: 'packages/storage/migrations/0001.sql' },
  { version: 2, file: 'packages/storage/migrations/0002.sql' }
] as const;

export type Row = Record<string, any>;
type Executor = { execute: (query: SQL) => Promise<{ rows: Row[]; rowCount: number | null }> };
function bind(text: string, values: unknown[]): SQL {
  const parts: SQL[] = []; let cursor = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    // Force a single bound parameter: Drizzle otherwise expands JS arrays as SQL tuples.
    parts.push(sql.raw(text.slice(cursor, match.index)), sql`${sql.param(values[Number(match[1]) - 1])}`);
    cursor = match.index! + match[0].length;
  }
  parts.push(sql.raw(text.slice(cursor))); return sql.join(parts, sql.raw(''));
}
export class Tx {
  constructor(readonly executor: Executor) {}
  async rows<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T[]> { return (await this.executor.execute(bind(text, values))).rows as T[]; }
  async one<T extends Row = Row>(text: string, values: unknown[] = []): Promise<T | undefined> { return (await this.rows<T>(text, values))[0]; }
  async exec(text: string, values: unknown[] = []) { return this.executor.execute(bind(text, values)); }
  get bossDb() { return { executeSql: async (text: string, values: unknown[] = []) => ({ rows: await this.rows(text, values) }) }; }
}
export class Store extends Tx {
  readonly pool: pg.Pool;
  readonly db: ReturnType<typeof drizzle>;
  constructor(url = process.env.DATABASE_URL) {
    if (!url) throw new Error('需要 DATABASE_URL；请通过 pnpm start 启动，或为开发实例配置数据库。');
    const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    pool.on('error', () => {});
    const db = drizzle(pool); super(db); this.pool = pool; this.db = db;
  }
  async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return this.db.transaction(tx => work(new Tx(tx))); }
  async snapshot<T>(work: (tx: Tx) => Promise<T>): Promise<T> { return this.db.transaction(tx => work(new Tx(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }); }
  async migrate() {
    await this.transaction(async tx => {
      await tx.exec('SELECT pg_advisory_xact_lock(847392001)');
      await tx.exec('CREATE SCHEMA IF NOT EXISTS app');
      await tx.exec('CREATE TABLE IF NOT EXISTS app.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await tx.rows('SELECT version FROM app.migrations')).map(row => row.version));
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        await tx.executor.execute(sql.raw(await readFile(resolve(migration.file), 'utf8')));
        await tx.exec('INSERT INTO app.migrations(version) VALUES($1)', [migration.version]);
      }
    });
  }
  async close() { await this.pool.end(); }
}
