import type { ErrandFacts, ModelNoticeFacts, VerifiedField } from '../../../contracts/src/errands.js';
import { locateQuote } from '../research/engine.js';

// Code-level guards complement saved rules: a rule makes the model try, these keep wrong facts out.
// "10 月 30 日 18:00 前将…发送" is the usual phrasing: a numeric date or time directly followed by 前
// (a digit is required so that 日前, "recently", does not count).
const DEADLINE =
  /截止|之前|以前|\d\s*(?:日|号|点|时|分)\s*前|\d[:：]\d{2}\s*前|前(?:提交|报名|发送|完成|上传|填写|交|报送)|不晚于|逾期|deadline|due|until|no later than|\bby\b/i;
const START =
  /开始|举行|举办|召开|开幕|开展|进行|定于|于\s*\d|(?:活动|会议|比赛|讲座|考试|报告|演出|开课|上课|答辩|面试)(?:时间|日期)|start|begin|held|takes place/i;

const LABELS = {
  organizer: '主办方',
  eventStart: '活动开始时间',
  eventEnd: '活动结束时间',
  registrationDeadline: '报名截止时间',
  submissionDeadline: '材料提交截止时间',
  location: '地点',
  contact: '联系方式',
} as const;

function digits(text: string) {
  return text.normalize('NFKC');
}
/** The quote must state the same month and day; a stated year must also agree. */
function dateAgrees(value: string, quote: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const text = digits(quote);
  if (!/\d/.test(text)) return { ok: true, note: '原文日期为中文数字，换算结果请核对' };
  const years = [...text.matchAll(/(20\d{2})\s*[年./-]/g)].map((match) => Number(match[1]));
  if (years.length && !years.includes(year)) return { ok: false, note: '' };
  const patterns = [
    new RegExp(`(^|\\D)0?${month}\\s*月\\s*0?${day}\\s*(日|号|$|\\D)`),
    new RegExp(`(^|\\D)0?${month}\\s*[./-]\\s*0?${day}($|\\D)`),
    new RegExp(`(^|\\D)${year}\\s*[./-]\\s*0?${month}\\s*[./-]\\s*0?${day}($|\\D)`),
  ];
  if (!patterns.some((pattern) => pattern.test(text))) return { ok: false, note: '' };
  return { ok: true, note: years.length ? '' : '原文未写年份，年份为推断' };
}

function field(
  name: keyof typeof LABELS,
  input: { value: string | null; quote: string },
  notice: string,
  unknowns: string[],
): VerifiedField {
  const label = LABELS[name];
  if (input.value === null || !input.value.trim()) return { value: null, quote: '', start: null, note: '' };
  const range = input.quote.trim() ? locateQuote(notice, input.quote.trim()) : null;
  if (!range) {
    unknowns.push(`${label}：模型给出的依据不在通知原文中，未采用`);
    return { value: null, quote: input.quote, start: null, note: '依据不在原文中' };
  }
  const quote = notice.slice(range[0], range[1]);
  let note = '';
  if (
    name === 'eventStart' ||
    name === 'eventEnd' ||
    name === 'registrationDeadline' ||
    name === 'submissionDeadline'
  ) {
    const agreement = dateAgrees(input.value, quote);
    if (!agreement.ok) {
      unknowns.push(`${label}：引文中的日期与提取结果不一致，未采用`);
      return { value: null, quote, start: range[0], note: '日期与引文不一致' };
    }
    note = agreement.note;
    if ((name === 'registrationDeadline' || name === 'submissionDeadline') && !DEADLINE.test(quote)) {
      unknowns.push(`${label}：引文没有“截止 / 之前”等含义，未采用`);
      return { value: null, quote, start: range[0], note: '引文不是截止时间' };
    }
    // Mask deadline phrases so "报名截止时间为…" cannot pass as a start time.
    if (
      name === 'eventStart' &&
      DEADLINE.test(quote) &&
      !START.test(quote.replace(new RegExp(DEADLINE.source, 'gi'), '§'))
    ) {
      unknowns.push('活动开始时间：引文只说明截止时间，不能当作活动开始时间');
      return { value: null, quote, start: range[0], note: '截止时间不是活动开始时间' };
    }
  }
  // A named contact ("研究生秘书 李老师") is kept only when the notice states it word for word.
  const compact = (text: string) => digits(text).replace(/\s+/g, '');
  if (
    name === 'contact' &&
    !/[^\s@]+@[^\s@]+\.[^\s@]+|\d{7,}/.test(digits(input.value)) &&
    !compact(quote).includes(compact(input.value))
  ) {
    unknowns.push('联系方式：既不是邮箱或电话，也不在原文中，未采用');
    return { value: null, quote, start: range[0], note: '格式无效' };
  }
  return { value: input.value.trim(), quote, start: range[0], note };
}

/** Keep only what the notice supports; everything else becomes an explicit unknown. */
export function verifyFacts(facts: ModelNoticeFacts, notice: string): ErrandFacts {
  const unknowns = [...facts.unknowns];
  const result: ErrandFacts = {
    title: facts.title,
    organizer: field('organizer', facts.organizer, notice, unknowns),
    eventStart: field('eventStart', facts.eventStart, notice, unknowns),
    eventEnd: field('eventEnd', facts.eventEnd, notice, unknowns),
    registrationDeadline: field('registrationDeadline', facts.registrationDeadline, notice, unknowns),
    submissionDeadline: field('submissionDeadline', facts.submissionDeadline, notice, unknowns),
    location: field('location', facts.location, notice, unknowns),
    contact: field('contact', facts.contact, notice, unknowns),
    materials: facts.materials.map((item) => ({ ...item, verified: Boolean(locateQuote(notice, item.quote)) })),
    actions: facts.actions.map((item) => ({ ...item, verified: Boolean(locateQuote(notice, item.quote)) })),
    unknowns: [],
  };
  result.unknowns = [...new Set(unknowns)].slice(0, 12);
  return result;
}

export const factLabels = LABELS;

/**
 * Who the reply goes to: the contact's address, else the one address the notice names,
 * else the notice's sender. Several unnamed addresses mean asking the owner instead of guessing.
 */
export function replyTarget(facts: ErrandFacts, notice: string, origin: { from?: string }) {
  const allowed = allowedRecipients(notice, origin);
  const stated = facts.contact.value?.toLowerCase().match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0];
  if (stated && allowed.includes(stated)) return stated;
  const named = allowedRecipients(notice, {});
  if (named.length === 1) return named[0]!;
  const sender = origin.from?.toLowerCase();
  return sender && allowed.includes(sender) ? sender : null;
}

/** Addresses the assistant may write to: those stated in the notice or the notice's own sender. */
export function allowedRecipients(notice: string, origin: { from?: string }) {
  const found = digits(notice).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  return [...new Set([...(origin.from ? [origin.from] : []), ...found].map((item) => item.toLowerCase()))];
}
