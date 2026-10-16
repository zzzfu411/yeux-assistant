import { describe, expect, it } from 'vitest';
import { detectIntent } from '../apps/web/src/intent.js';

describe('guessing the Today tab from what was written', () => {
  it('leaves an empty page undecided', () => {
    expect(detectIntent('')).toBeNull();
    expect(detectIntent('   \n')).toBeNull();
  });

  it('recognises a pasted notice even when it also says 整理 or 安排', () => {
    const notice =
      '关于举办课程展示的通知\n各位同学：课程展示定于 11 月 20 日 14:00 在仙Ⅱ-204 举行。请于 11 月 10 日 23:59 前将报名表发送至 gse-ta@nju.edu.cn，并安排好时间。';
    expect(detectIntent(notice)).toMatchObject({ mode: 'errand', confident: true });
    expect(detectIntent('请于 2026-11-10 前提交申请表至教务办，联系人：王老师，电话 8359。')?.mode).toBe('errand');
  });

  it('separates research, goals, planning, material and questions', () => {
    expect(detectIntent('比较关系型数据库与文档数据库，给出选型依据和反例。')?.mode).toBe('research');
    expect(detectIntent('理解数据库事务，能解释四种隔离级别。')?.mode).toBe('goal');
    expect(detectIntent('明天有 1 小时，安排数据库复习，并列出复盘要点。')?.mode).toBe('manage');
    expect(detectIntent('把下面的会议记录整理成三条要点：周三讨论了接口设计与测试分工。')?.mode).toBe('work');
    expect(detectIntent('什么是左连接？')?.mode).toBe('study');
  });

  it('falls back by length when nothing matches, and says it is unsure', () => {
    expect(detectIntent('关系代数')).toMatchObject({ mode: 'study', confident: false });
    expect(detectIntent('甲'.repeat(300))).toMatchObject({ mode: 'work', confident: false });
  });

  it('does not take a long passage as a learning goal', () => {
    expect(detectIntent('我想掌握' + '这一段很长的材料内容。'.repeat(30))?.mode).not.toBe('goal');
  });

  it('reads full-width punctuation and digits the same way', () => {
    expect(detectIntent('请于１１月１０日２３:５９前报名，发送至ｔａ＠ｅｘａｍｐｌｅ.ｅｄｕ')?.mode).toBe('errand');
  });
});
