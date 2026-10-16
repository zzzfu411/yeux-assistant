import { describe, expect, it } from 'vitest';
import { affected } from '../apps/web/src/live.js';

describe('which cached reads an event refreshes', () => {
  const reads = [
    '/today/overview',
    '/sessions/session-1',
    '/sessions/session-1/trace',
    '/goals/goal-1/overview',
    '/sources',
    '/search',
    '/mail/threads/t1',
    '/devices',
    '/notifications?page=0',
    '/memories',
    '/drafts/compose',
    '/settings/model',
  ];
  const hit = (kind: string) => reads.filter(affected(kind));
  it('refreshes task pages for run progress but leaves unrelated pages alone', () => {
    expect(hit('research.progress')).toEqual([
      '/today/overview',
      '/sessions/session-1',
      '/sessions/session-1/trace',
      '/goals/goal-1/overview',
    ]);
    expect(hit('source.updated')).toEqual(['/today/overview', '/sources', '/search']);
    expect(hit('draft.updated')).toEqual(['/drafts/compose']);
    expect(hit('notification')).toEqual(['/today/overview', '/notifications?page=0']);
  });
  it('refreshes everything on a reset and for an event kind it does not know', () => {
    expect(hit('stream.reset')).toEqual(reads);
    expect(hit('something.new')).toEqual(reads);
  });
  it('matches whole path segments only', () => {
    expect(affected('source.updated')('/sourcesx')).toBe(false);
    expect(affected('mail.received')('/mailbox')).toBe(false);
  });
});
