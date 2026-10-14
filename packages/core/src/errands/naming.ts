// Names for "save as flow". A keyword routes future mail into the flow automatically, so it must
// say what the notice is about: "关于" or "2026" would capture almost every notice.
const BOILERPLATE = [
  /^\s*(?:关于|有关)/,
  /(?:的)?(?:通知|公告|公示|通告|说明|提醒)\s*$/,
  /20\d{2}\s*(?:[-–至到]\s*20\d{2}\s*)?(?:年|学年)?(?:度)?/g,
  /[春夏秋冬]季?学期/g,
  /第[一二三四五六七八九十百\d]+(?:届|期|次|批|轮|学期)/g,
];
const STOP = new Set([
  '关于',
  '有关',
  '通知',
  '公告',
  '举办',
  '开展',
  '做好',
  '工作',
  '相关',
  '事项',
  '同学',
  '各位',
  '学生',
]);

/** Up to three subject keywords that identify this kind of notice. */
export function subjectKeywords(title: string) {
  let core = title.normalize('NFKC');
  for (const pattern of BOILERPLATE) core = core.replace(pattern, ' ');
  const words = core
    .split(/[\s,，。:：;；、()（）【】\[\]“”"'《》<>|/\\-]+|的/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 16 && !STOP.has(word) && !/^[\d.]+$/.test(word));
  return [...new Set(words)].slice(0, 3);
}

/** A readable id when the title has an ASCII word (GSE, lab2); otherwise a stable digest-based id. */
export function flowSlug(title: string, fallback: string) {
  const ascii = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/20\d{2}/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii.length >= 3 && /[a-z]/.test(ascii) ? ascii : fallback;
}

/** A readable record file name such as "研究生学术报告会报名" (the private workspace is read by people). */
export function recordName(title: string, fallback: string) {
  const name = (subjectKeywords(title).join('-') || title)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return name.length >= 2 && /[\p{L}]/u.test(name) ? name : fallback;
}
