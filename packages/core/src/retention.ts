import type { Store } from '../../storage/src/index.js';
import { getValue, putValue } from './kv.js';

/**
 * Only derived, append-only data is pruned. Business records, step receipts (a waiting answer may
 * still need its exercise receipt) and learning checkpoints are kept indefinitely.
 */
export const RETENTION = { eventDays: 30, traceDays: 180 } as const;
/** At most once per day: published live-update events and the call trace of long-finished runs. */
export async function pruneDerived(store: Store, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return store.transaction(async (tx) => {
    await tx.exec("SELECT pg_advisory_xact_lock(hashtextextended('retention',0))");
    if ((await getValue(tx, 'retention', 'last')) === today) return null;
    // A browser holding an older cursor resumes after it and refreshes every page on reconnect.
    const events = await tx.exec(
      'DELETE FROM app.events WHERE stream_id IS NOT NULL AND created_at < $1::timestamptz - make_interval(days => $2)',
      [now.toISOString(), RETENTION.eventDays],
    );
    const calls = await tx.exec(
      `DELETE FROM app.model_calls m USING app.runs r
      WHERE m.run_id=r.id AND r.state IN ('succeeded','failed','cancelled')
      AND r.finished_at < $1::timestamptz - make_interval(days => $2)`,
      [now.toISOString(), RETENTION.traceDays],
    );
    await putValue(tx, 'retention', 'last', today);
    return { events: events.rowCount ?? 0, modelCalls: calls.rowCount ?? 0 };
  });
}
