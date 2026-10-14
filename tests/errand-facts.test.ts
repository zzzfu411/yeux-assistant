import { describe, expect, it } from 'vitest';
import type { ModelNoticeFacts } from '../packages/contracts/src/errands.js';
import { allowedRecipients, replyTarget, verifyFacts } from '../packages/core/src/errands/facts.js';
import { calendarEvents, toICS } from '../packages/core/src/errands/calendar.js';
import { flowSlug, recordName, subjectKeywords } from '../packages/core/src/errands/naming.js';

const notice =
  '关于举办 2026 年秋季课程展示的通知\n课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行。' +
  '报名截止时间为 11 月 10 日 23:59，请将报名表发送至 gse-ta@nju.edu.cn。联系人：王助教。';
const empty = { value: null, quote: '' };
function facts(overrides: Partial<ModelNoticeFacts> = {}): ModelNoticeFacts {
  return {
    title: '课程展示',
    organizer: empty,
    eventStart: { value: '2026-11-20 14:00', quote: '课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行' },
    eventEnd: empty,
    registrationDeadline: { value: '2026-11-10 23:59', quote: '报名截止时间为 11 月 10 日 23:59' },
    submissionDeadline: empty,
    location: { value: '仙Ⅱ-204', quote: '在仙Ⅱ-204 举行' },
    contact: { value: 'gse-ta@nju.edu.cn', quote: '发送至 gse-ta@nju.edu.cn' },
    materials: [{ name: '报名表', quote: '请将报名表发送至', required: true }],
    actions: [{ action: '邮件报名', quote: '不在原文里的句子', channel: 'email' }],
    unknowns: [],
    ...overrides,
  };
}

describe('notice facts are kept only when the notice supports them', () => {
  it('keeps quoted, consistent facts and marks an inferred year', () => {
    const result = verifyFacts(facts(), notice);
    expect(result.eventStart).toMatchObject({ value: '2026-11-20 14:00', note: '原文未写年份，年份为推断' });
    expect(result.registrationDeadline.value).toBe('2026-11-10 23:59');
    expect(notice.slice(result.location.start!, result.location.start! + result.location.quote.length)).toBe(
      result.location.quote,
    );
    expect(result.materials[0]!.verified).toBe(true);
    expect(result.actions[0]!.verified).toBe(false);
  });
  it('never takes a registration deadline as the event start (the Lab1 example rule)', () => {
    const result = verifyFacts(
      facts({ eventStart: { value: '2026-11-10 23:59', quote: '报名截止时间为 11 月 10 日 23:59' } }),
      notice,
    );
    expect(result.eventStart.value).toBeNull();
    expect(result.unknowns.join()).toContain('不能当作活动开始时间');
  });
  it('rejects quotes missing from the notice, mismatched dates and deadlines without deadline wording', () => {
    const result = verifyFacts(
      facts({
        eventEnd: { value: '2026-11-21', quote: '活动持续两天' },
        registrationDeadline: { value: '2026-11-12 23:59', quote: '报名截止时间为 11 月 10 日 23:59' },
        submissionDeadline: { value: '2026-11-20 14:00', quote: '课程展示定于 11 月 20 日 14:00' },
      }),
      notice,
    );
    expect(result.eventEnd.value).toBeNull();
    expect(result.registrationDeadline.value).toBeNull();
    expect(result.submissionDeadline.value).toBeNull();
    expect(result.unknowns).toEqual(
      expect.arrayContaining([
        expect.stringContaining('依据不在通知原文中'),
        expect.stringContaining('日期与提取结果不一致'),
        expect.stringContaining('没有“截止 / 之前”'),
      ]),
    );
  });
  it('tolerates re-spaced quotes and rejects a stated year that disagrees', () => {
    const spaced = verifyFacts(facts({ location: { value: '仙Ⅱ-204', quote: '在 仙Ⅱ-204举行' } }), notice);
    expect(spaced.location.value).toBe('仙Ⅱ-204');
    const yearNotice = '活动于 2026 年 11 月 20 日举行。';
    expect(
      verifyFacts(facts({ eventStart: { value: '2025-11-20', quote: '活动于 2026 年 11 月 20 日举行' } }), yearNotice)
        .eventStart.value,
    ).toBeNull();
  });
  it('limits recipients to addresses in the notice or its sender', () => {
    expect(allowedRecipients(notice, {})).toEqual(['gse-ta@nju.edu.cn']);
    expect(allowedRecipients('请回复本邮件', { from: 'Office@NJU.edu.cn' })).toEqual(['office@nju.edu.cn']);
  });
  it('reads a time followed by 前 as a deadline and keeps a named contact stated in the notice', () => {
    // Phrasing from a real notice that grok-4.6 extracted correctly but the first verifier rejected.
    const real =
      '学院定于 2026 年 11 月 6 日（周五）14:00 在仙Ⅱ-101 举办研究生学术报告会。有意报告的同学请于 10 月 30 日 18:00 前将报名表和报告摘要发送至 se-grad@nju.edu.cn。联系人：研究生秘书 李老师。';
    const quote = '有意报告的同学请于 10 月 30 日 18:00 前将报名表和报告摘要发送至 se-grad@nju.edu.cn';
    const result = verifyFacts(
      facts({
        eventStart: { value: '2026-11-06 14:00', quote: '学院定于 2026 年 11 月 6 日（周五）14:00 在仙Ⅱ-101 举办' },
        registrationDeadline: { value: '2026-10-30 18:00', quote },
        location: empty,
        contact: { value: '研究生秘书 李老师', quote: '联系人：研究生秘书 李老师。' },
        materials: [],
        actions: [],
      }),
      real,
    );
    expect(result.registrationDeadline.value).toBe('2026-10-30 18:00');
    // The same sentence sets both deadlines: the calendar gets one reminder for it.
    const both = verifyFacts(
      facts({
        eventStart: empty,
        registrationDeadline: { value: '2026-10-30 18:00', quote },
        submissionDeadline: { value: '2026-10-30 18:00', quote },
        location: empty,
        contact: empty,
        materials: [],
        actions: [],
      }),
      real,
    );
    expect(calendarEvents(both).map((event) => event.title)).toEqual(['截止：报名与提交材料 · 课程展示']);
    expect(result.eventStart.value).toBe('2026-11-06 14:00');
    expect(result.contact.value).toBe('研究生秘书 李老师');
    const recently = '日前，学院决定 11 月 20 日举办课程展示。';
    expect(
      verifyFacts(
        facts({ registrationDeadline: { value: '2026-11-20', quote: recently }, eventStart: empty }),
        recently,
      ).registrationDeadline.value,
    ).toBeNull();
    expect(
      verifyFacts(facts({ contact: { value: '张老师', quote: '联系人：研究生秘书 李老师。' } }), real).contact.value,
    ).toBeNull();
    // The contact has no address, so the one address the notice names receives the reply.
    expect(replyTarget(result, real, {})).toBe('se-grad@nju.edu.cn');
    expect(replyTarget(result, real + '抄送 a@nju.edu.cn。', { from: 'office@nju.edu.cn' })).toBe('office@nju.edu.cn');
    expect(replyTarget(result, real + '抄送 a@nju.edu.cn。', {})).toBeNull();
  });
  it('exports the start and each deadline as separate calendar entries', () => {
    const verified = verifyFacts(facts(), notice);
    const events = calendarEvents(verified);
    expect(events.map((event) => event.kind)).toEqual(['start', 'deadline']);
    expect(events[1]!.title).toMatch(/^截止：报名/);
    const ics = toICS('session-1', events, verified.location.value, new Date('2026-10-12T00:00:00Z'));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20261120T140000');
    expect(ics).toContain('LOCATION:仙Ⅱ-204');
    expect(ics).toContain('TRIGGER:-P1D');
    expect(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  });
  it('names a saved flow by what the notice is about, never by 关于 or the year', () => {
    // A real notice title produced id "2026" and keywords ["关于", "2026"] before this rule.
    const title = '关于 2026 年秋季学期研究生学术报告会报名的通知';
    expect(subjectKeywords(title)).toEqual(['研究生学术报告会报名']);
    expect(flowSlug(title, 'notice-1a2b3c4d')).toBe('notice-1a2b3c4d');
    expect(subjectKeywords('GSE 课程展示报名')).toEqual(['GSE', '课程展示报名']);
    expect(flowSlug('GSE 课程展示报名', 'x')).toBe('gse');
    expect(subjectKeywords('关于做好2026-2027学年第一学期选课工作的通知')).toEqual(['选课工作']);
    expect(subjectKeywords('通知')).toEqual([]);
    expect(recordName(title, 'errand-1')).toBe('研究生学术报告会报名');
    expect(recordName('GSE 课程展示报名', 'errand-1')).toBe('GSE-课程展示报名');
    expect(recordName('2026 通知', 'errand-1')).toBe('2026-通知');
    expect(recordName('—— 2026 ——', 'errand-1')).toBe('errand-1');
  });
});
