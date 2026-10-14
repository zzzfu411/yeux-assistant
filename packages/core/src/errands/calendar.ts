import type { ErrandFacts, ErrandState } from '../../../contracts/src/errands.js';

type Event = ErrandState['calendar'][number];

/** Event start and each deadline are separate entries; a deadline is never shown as the event time. */
export function calendarEvents(facts: ErrandFacts): Event[] {
  const events: Event[] = [];
  const add = (kind: Event['kind'], title: string, value: string | null) => {
    if (!value) return;
    events.push({ kind, title, at: value.replace(' ', 'T'), allDay: !/[T ]\d{2}:\d{2}/.test(value) });
  };
  add('start', facts.title, facts.eventStart.value);
  // "请于 10 月 30 日 18:00 前将报名表和摘要发送至…" sets both deadlines at once: one reminder, not two.
  if (facts.registrationDeadline.value && facts.registrationDeadline.value === facts.submissionDeadline.value)
    add('deadline', '截止：报名与提交材料 · ' + facts.title, facts.registrationDeadline.value);
  else {
    add('deadline', '截止：报名 · ' + facts.title, facts.registrationDeadline.value);
    add('deadline', '截止：提交材料 · ' + facts.title, facts.submissionDeadline.value);
  }
  return events;
}

const escape = (text: string) =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/[,;]/g, (c) => '\\' + c)
    .replace(/\r?\n/g, '\\n');
const stamp = (at: string) => at.replace(/[-:]/g, '').slice(0, 15).padEnd(15, '0');
/** RFC 5545 lines are folded at 75 octets. */
function fold(line: string) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  for (const char of line) {
    if (Buffer.byteLength(current + char) > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
    }
    current += char;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** A standalone file the phone imports into its own calendar; no calendar account is touched. */
export function toICS(sessionId: string, events: Event[], location: string | null, created = new Date()) {
  const now = created
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//yeux-assitant//errand//ZH',
    'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  events.forEach((event, index) => {
    const date = event.at.slice(0, 10).replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${sessionId}-${index}@yeux-assitant`,
      `DTSTAMP:${now}`,
      ...(event.allDay
        ? [`DTSTART;VALUE=DATE:${date}`]
        : [
            `DTSTART;TZID=Asia/Shanghai:${stamp(event.at)}`,
            `DURATION:${event.kind === 'deadline' ? 'PT15M' : 'PT1H'}`,
          ]),
      `SUMMARY:${escape(event.title)}`,
      ...(location && event.kind === 'start' ? [`LOCATION:${escape(location)}`] : []),
      ...(event.kind === 'deadline'
        ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(event.title)}`, 'TRIGGER:-P1D', 'END:VALARM']
        : []),
      'END:VEVENT',
    );
  });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
