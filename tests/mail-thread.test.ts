import { describe, expect, it } from 'vitest';
import {
  isBulk,
  matchesBySubject,
  replyContext,
  replyReferences,
  replySubject,
  subjectKey,
  withoutQuotedHistory,
} from '../packages/core/src/mail/thread.js';

const headers = (values: Record<string, string> = {}) => ({ get: (name: string) => values[name] });

describe('mail threading helpers', () => {
  it('folds reply and forward prefixes in English and Chinese, half and full width', () => {
    for (const subject of [
      '关于周五组会的安排',
      'Re: 关于周五组会的安排',
      'RE：Re: 关于周五组会的安排',
      '回复：关于周五组会的安排',
      '答复: 转发：关于周五组会的安排',
      'Fwd: 关于周五组会的安排',
      'Re[2]: 关于周五组会的安排',
      '  ＲＥ：关于周五组会的安排  ',
    ])
      expect(subjectKey(subject)).toBe('关于周五组会的安排');
    expect(subjectKey('Report v2')).toBe('report v2');
  });
  it('adds Re: once and keeps a single line', () => {
    expect(replySubject('组会安排')).toBe('Re: 组会安排');
    expect(replySubject('Re: 组会安排')).toBe('Re: 组会安排');
    expect(replySubject('回复：组会安排')).toBe('回复：组会安排');
    expect(replySubject('多行\n主题')).toBe('Re: 多行 主题');
  });
  it('builds bounded References with the replied message last', () => {
    const chain = Array.from({ length: 25 }, (_, i) => `<m${i}@x>`);
    const references = replyReferences({ messageId: '<last@x>', references: chain });
    expect(references).toHaveLength(20);
    expect(references.at(-1)).toBe('<last@x>');
    expect(replyContext('thread', { references: ['<a@x>'] }, '<b@x>')).toMatchObject({
      threadId: 'thread',
      inReplyTo: '<b@x>',
      references: ['<a@x>', '<b@x>'],
      cc: [],
    });
  });
  it('treats lists and Bcc-only delivery as bulk, direct mail as personal', () => {
    const me = 'Me@smail.nju.edu.cn';
    expect(isBulk(headers(), me, ['me@smail.nju.edu.cn'], [])).toBe(false);
    expect(isBulk(headers(), me, ['other@x.cn'], ['me@smail.nju.edu.cn'])).toBe(false);
    expect(isBulk(headers({ 'list-id': '<course.list>' }), me, ['me@smail.nju.edu.cn'], [])).toBe(true);
    expect(isBulk(headers({ precedence: 'bulk' }), me, ['me@smail.nju.edu.cn'], [])).toBe(true);
    expect(isBulk(headers(), me, ['all-students@nju.edu.cn'], [])).toBe(true);
  });
  it('joins by subject only with a shared participant within 60 days', () => {
    const thread = { id: 't', participants: ['ta@nju.edu.cn'], lastMessageAt: new Date('2026-10-01') };
    expect(matchesBySubject(thread, ['ta@nju.edu.cn'], new Date('2026-10-20'))).toBe(true);
    expect(matchesBySubject(thread, ['someone@else.cn'], new Date('2026-10-20'))).toBe(false);
    expect(matchesBySubject(thread, ['ta@nju.edu.cn'], new Date('2027-01-20'))).toBe(false);
  });
  it('strips quoted history but never returns an empty body', () => {
    expect(withoutQuotedHistory('好的，周五见。\n\n在 2026年10月12日，助教 写道：\n> 请确认时间')).toBe(
      '好的，周五见。',
    );
    expect(withoutQuotedHistory('Thanks!\nOn Mon, TA wrote:\n> old')).toBe('Thanks!');
    expect(withoutQuotedHistory('> 只有引用')).toBe('> 只有引用');
  });
});
