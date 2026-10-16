import { z } from 'zod';
import type { Tx } from '../../storage/src/index.js';
import { AppError } from './common.js';

/**
 * The small records kept in app.settings, each under `<space>:<id>`. Key formats and stored values
 * are unchanged from earlier releases, so existing rows stay valid; every read is checked against
 * its space's schema, and only this module writes the table.
 */
const SPACES = {
  /** Confirmed rules and notes as one run first saw them; retries reuse the same snapshot. */
  'run-rules': z.array(z.record(z.string(), z.unknown())),
  /** Digest of the goal title, outcome and sources the current plan was made for. */
  'plan-intent': z.string(),
  /** Which practised step the next review of a goal starts from. */
  'review-index': z.coerce.number().int().min(0),
  /** The committed result of assessing one answer; a retried run resumes from it. */
  assessment: z
    .object({
      attemptId: z.string(),
      verdict: z.string(),
      stepId: z.string().nullable(),
      done: z.boolean(),
    })
    .passthrough(),
  /** A message that could not be imported, kept aside with its reason. */
  'mail-quarantine': z.record(z.string(), z.unknown()),
  /** Highest imported IMAP UID per account, folder and UIDVALIDITY (stored as a decimal string). */
  mail: z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]).transform(Number),
  /** One imported message: its identity digest, thread and source, so a re-poll never duplicates it. */
  'mail-source': z.record(z.string(), z.unknown()),
  /** Drafts written automatically on one day, for the daily limit. */
  'mail-drafts': z.number().int().min(0),
  /** The last day derived data was pruned. */
  retention: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
} as const;
export type Space = keyof typeof SPACES;
type Value<S extends Space> = z.output<(typeof SPACES)[S]>;
type Writer = Pick<Tx, 'one' | 'exec'>;
const keyOf = (space: Space, id: string) => {
  if (!id) throw new AppError('记录标识为空。');
  return space + ':' + id;
};

export async function getValue<S extends Space>(tx: Pick<Tx, 'one'>, space: S, id: string) {
  const row = await tx.one('SELECT value FROM app.settings WHERE key=$1', [keyOf(space, id)]);
  if (!row) return undefined;
  const parsed = SPACES[space].safeParse(row.value);
  if (!parsed.success) throw new AppError(`内部记录 ${space} 格式无效，已停止处理以免覆盖。`, 500, 'record_invalid');
  return parsed.data as Value<S>;
}
/** Insert or replace. */
export async function putValue<S extends Space>(tx: Writer, space: S, id: string, value: z.input<(typeof SPACES)[S]>) {
  SPACES[space].parse(value);
  await tx.exec(
    'INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [keyOf(space, id), JSON.stringify(value)],
  );
}
/** Insert only if absent; an existing record wins and is kept. */
export async function addValue<S extends Space>(tx: Writer, space: S, id: string, value: z.input<(typeof SPACES)[S]>) {
  SPACES[space].parse(value);
  await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING', [
    keyOf(space, id),
    JSON.stringify(value),
  ]);
}
/** Insert exactly once; a second insert is a conflict, never a silent overwrite. */
export async function insertValue<S extends Space>(
  tx: Writer,
  space: S,
  id: string,
  value: z.input<(typeof SPACES)[S]>,
) {
  SPACES[space].parse(value);
  await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)', [keyOf(space, id), JSON.stringify(value)]);
}
/** Only for importing a legacy database: copies its settings rows exactly as they were. */
export async function importLegacyValue(tx: Writer, key: string, value: unknown) {
  await tx.exec('INSERT INTO app.settings(key,value) VALUES($1,$2)', [key, JSON.stringify(value)]);
}
