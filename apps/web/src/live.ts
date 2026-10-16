import { createContext, useContext } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/** Whether the event stream is connected; while it is, pages stop polling and wait for events. */
export const LiveContext = createContext(false);
export const useLive = () => useContext(LiveContext);

const startsWith =
  (...prefixes: string[]) =>
  (path: string) =>
    prefixes.some(
      (prefix) =>
        path === prefix ||
        path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') ||
        path.startsWith(prefix + '?'),
    );
const everything = () => true;
/**
 * Which cached reads an event can change. Unknown kinds refresh every active read, so a new kind of
 * event is never silently missed; known kinds refresh only the pages that show what changed.
 */
export function affected(kind: string): (path: string) => boolean {
  const family = kind.split('.')[0]!;
  if (kind === 'stream.reset' || kind === 'legacy.imported') return everything;
  if (family === 'source') return startsWith('/sources', '/search', '/today');
  if (['run', 'session', 'research', 'errand', 'attempt', 'context', 'review'].includes(family))
    return startsWith('/sessions', '/goals', '/today');
  if (family === 'plan' || family === 'goal') return startsWith('/goals', '/sessions', '/today');
  if (family === 'notification') return startsWith('/notifications', '/today');
  if (family === 'mail') return startsWith('/mail', '/sessions', '/today', '/notifications');
  if (family === 'device') return startsWith('/devices', '/device-commands', '/notifications', '/today');
  if (family === 'memory' || family === 'flow') return startsWith('/memories', '/workspace', '/flows', '/today');
  if (family === 'schedule') return startsWith('/schedules', '/today');
  if (family === 'draft') return startsWith('/drafts');
  return everything;
}
/** After a write, refresh only the reads under these paths; events from the server follow anyway. */
export function refresh(client: QueryClient, ...prefixes: string[]) {
  const match = startsWith(...prefixes);
  return client.invalidateQueries({
    predicate: (query) => typeof query.queryKey[0] !== 'string' || match(query.queryKey[0]),
  });
}
