import type { SessionMail } from '../../../contracts/src/mail.js';

/** Pure helpers for threading and reply headers; no I/O so they can be tested directly. */

const PREFIX = /^\s*(?:re|fw|fwd|aw|sv|回复|答复|回覆|转发|轉寄)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;

/** A stable key for "the same conversation": reply / forward prefixes removed, width and case folded. */
export function subjectKey(subject: string) {
  let value = subject.normalize('NFKC').trim(),
    previous = '';
  while (value !== previous) {
    previous = value;
    value = value.replace(PREFIX, '');
  }
  return value.replace(/\s+/g, ' ').toLowerCase().trim();
}

export function replySubject(subject: string) {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim() || '(无主题)';
  return /^\s*(?:re|回复|答复)\s*[:：]/i.test(clean) ? clean : 'Re: ' + clean;
}

export const normalizeAddress = (value: string | null | undefined) => (value || '').trim().toLowerCase();

/** RFC 5322 References for a reply: the original chain plus the replied message, newest last, bounded. */
export function replyReferences(original: { messageId: string | null; references: string[] }) {
  const chain = [...original.references, ...(original.messageId ? [original.messageId] : [])].filter(Boolean);
  return [...new Set(chain)].slice(-20);
}

export type HeaderBag = { get(name: string): unknown };

/**
 * Mailing lists and messages where the owner is only in Bcc are not personal correspondence.
 * They are kept as history but never drafted automatically.
 */
export function isBulk(headers: HeaderBag, owner: string, to: string[], cc: string[]) {
  const precedence = String(headers.get('precedence') || '').toLowerCase();
  if (headers.get('list-id') || headers.get('list-unsubscribe') || /^(bulk|list|junk)$/.test(precedence)) return true;
  const me = normalizeAddress(owner);
  return Boolean(me) && ![...to, ...cc].map(normalizeAddress).includes(me);
}

export type ThreadCandidate = { id: string; participants: string[]; lastMessageAt: Date };

/** Same subject key alone is not enough: a thread also needs a shared participant within 60 days. */
export function matchesBySubject(candidate: ThreadCandidate, participants: string[], at: Date | null) {
  const shared = candidate.participants.some((p) => participants.includes(p));
  const recent = !at || Math.abs(at.getTime() - candidate.lastMessageAt.getTime()) <= 60 * 86400000;
  return shared && recent;
}

/** Strip quoted history so the model and the thread view see what was actually written. */
export function withoutQuotedHistory(body: string) {
  const lines = body.split(/\r?\n/);
  const stop = lines.findIndex(
    (line) =>
      /^\s*-{2,}\s*(?:original message|原始邮件|回复的原邮件)\s*-{2,}/i.test(line) ||
      /^\s*On .+ wrote:\s*$/i.test(line) ||
      /^\s*在\s?.+写道[:：]\s*$/.test(line) ||
      /^\s*发件人[:：]/.test(line),
  );
  const kept = (stop >= 0 ? lines.slice(0, stop) : lines).filter((line) => !/^\s*>/.test(line));
  return kept.join('\n').trim() || body.trim();
}

/** Reply headers bound to a session; the owner confirms them together with the text. */
export function replyContext(
  threadId: string,
  original: { references: string[] },
  messageId: string | null,
): SessionMail {
  return {
    threadId,
    replyTo: messageId,
    inReplyTo: messageId,
    references: replyReferences({ messageId, references: original.references }),
    cc: [],
    questions: [],
  };
}
