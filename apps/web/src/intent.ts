/**
 * Guess what the owner wants from what they wrote, so the page does not ask them to pick a mode first.
 * Plain local rules: instant, free and explainable. The guess is only a default; choosing a tab overrides it.
 */
export type TaskMode = 'research' | 'goal' | 'study' | 'errand' | 'work' | 'manage';
export type Intent = { mode: TaskMode; reason: string; confident: boolean };

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function detectIntent(input: string): Intent | null {
  const text = input.normalize('NFKC').trim();
  if (!text) return null;
  const long = text.length > 160;
  // A notice names dates, deadlines and where to send things.
  const dates = count(text, /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}/g),
    noticeWords = count(text, /通知|报名|截止|请于|前将|提交至|发送至|各位同学|各位老师|办理|申请表|附件|务必|逾期/g),
    contact = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|电话|联系人/.test(text);
  const scores: Record<TaskMode, number> = {
    errand: noticeWords * 2 + Math.min(dates, 3) * 2 + (contact ? 2 : 0) + (text.length > 80 ? 1 : 0),
    research: count(text, /比较|对比|选型|调研|评估|利弊|优缺点|权衡|哪个更|是否应该|论证|查证|依据|反例/g) * 3,
    goal:
      count(text, /学会|掌握|目标|备考|复习完|弄懂|搞懂|入门|系统地?学|能够|能解释|能独立|能写出/g) * 3 -
      (text.length > 200 ? 4 : 0),
    manage: count(text, /安排|日程|待办|复盘|计划一下|今天|明天|本周|下周|\d+\s*(?:个)?(?:小时|分钟)/g) * 2,
    work: count(text, /整理|摘要|总结|提炼|改写|润色|翻译|草稿|归纳|列出|要点/g) * 2 + (long ? 2 : 0),
    study: count(text, /什么是|为什么|怎么|如何|解释|举例|区别|是什么|原理|[?？]/g) * 2,
  };
  // A pasted notice usually also says "整理" or "安排"; enough notice signals win outright.
  if (scores.errand >= 7)
    return { mode: 'errand', reason: '有日期、截止或联系方式，像一份要办的通知', confident: true };
  const order: TaskMode[] = ['research', 'goal', 'manage', 'work', 'study', 'errand'];
  const best = order.reduce((top, mode) => (scores[mode] > scores[top] ? mode : top), order[0]!);
  if (scores[best] < 2)
    return long
      ? { mode: 'work', reason: '一段较长的材料，先按整理处理', confident: false }
      : { mode: 'study', reason: '一个具体的问题，先按答疑处理', confident: false };
  const reasons: Record<TaskMode, string> = {
    errand: '像一份要办的通知',
    research: '要比较方案或查证依据',
    goal: '是一个要持续练习的学习目标',
    manage: '在安排时间或复盘',
    work: '要整理一段材料',
    study: '是一个想弄懂的问题',
  };
  return { mode: best, reason: reasons[best], confident: scores[best] >= 4 };
}
