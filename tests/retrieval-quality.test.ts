import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Store, type Row } from '../packages/storage/src/index.js';
import { citationFromRow, putSource, retrieve } from '../packages/core/src/knowledge.js';
import { candidateTerms, searchTerms, selectTerms } from '../packages/core/src/search.js';

type Cases = {
  documents: Array<{ id: string; title: string; path: string | null; text: string }>;
  queries: Array<{ query: string; relevant: string }>;
};

describe('choosing query terms', () => {
  const stats = (documents: number, frequency: Record<string, number>) => ({
    documents,
    averageLength: 100,
    frequency: new Map(Object.entries(frequency)),
  });
  it('keeps single Han characters only where the query wrote one on its own', () => {
    expect(searchTerms('数据库 表', true).sort()).toEqual(['数据', '据库', '表'].sort());
    expect(searchTerms('数据库').sort()).toEqual(['库', '据', '据库', '数', '数据'].sort());
    expect(searchTerms('ＳＱＬ Index_B a', true)).toEqual(['sql', 'index_b']);
  });
  it('orders by rarity, drops absent and very common terms, and keeps something when all are common', () => {
    const corpus = stats(40, { 奖学: 1, 学金: 1, 学习: 30, 请大: 25, 推荐: 2 });
    expect(selectTerms(corpus, ['学习', '请大', '推荐', '奖学', '学金', '不存在'])).toEqual(['奖学', '学金', '推荐']);
    expect(selectTerms(corpus, ['学习', '请大'])).toEqual(['请大', '学习']);
    // A small corpus has no reliable notion of "common".
    expect(selectTerms(stats(3, { 学习: 3 }), ['学习'])).toEqual(['学习']);
  });
  it('filters candidates with the rarest terms that fit the budget, always at least one', () => {
    const corpus = stats(5000, { a1: 10, b2: 300, c3: 400, d4: 900 });
    expect(candidateTerms(corpus, ['a1', 'b2', 'c3', 'd4'], 600)).toEqual(['a1', 'b2']);
    expect(candidateTerms(corpus, ['d4', 'a1'], 600)).toEqual(['d4']);
  });
});

const url = process.env.RUNTIME_TEST_DATABASE_URL;
// The implementation before migration 0017: bigram ILIKE filtering, the last 48 terms, raw match counts.
function legacyTerms(query: string) {
  const result: string[] = [];
  for (const token of query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) || []) {
    if (/\p{Script=Han}/u.test(token) && token.length > 2) {
      for (let i = 0; i < token.length - 1; i++) result.push(token.slice(i, i + 2));
    } else result.push(token);
  }
  return [...new Set(result)].slice(-48);
}
async function legacyRetrieve(store: Store, query: string, limit: number) {
  const words = legacyTerms(query);
  if (!words.length) return [];
  const patterns = words.map((t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%');
  const rows = await store.rows(
    `SELECT c.id,c.source_id,c.version,c.start_offset,c.end_offset,c.content,v.title,v.digest,v.metadata FROM app.chunks c JOIN app.sources s ON c.source_id=s.id AND c.version=s.version
    JOIN app.source_versions v ON v.source_id=c.source_id AND v.version=c.version
    WHERE s.archived_at IS NULL AND s.missing_at IS NULL AND c.content ILIKE ANY($1::text[])
    ORDER BY word_similarity($2,c.content) DESC,c.id LIMIT 80`,
    [patterns, query.slice(-300)],
  );
  return rows
    .map((row: Row) => ({ row, score: words.reduce((n, t) => n + Number(row.content.toLowerCase().includes(t)), 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => citationFromRow(row));
}
function measure(ranked: string[][], cases: Cases['queries']) {
  let hits = 0,
    reciprocal = 0;
  const misses: string[] = [];
  cases.forEach((item, index) => {
    const position = ranked[index]!.indexOf(item.relevant);
    if (position >= 0 && position < 5) hits++;
    else misses.push(item.query.slice(0, 18));
    if (position >= 0) reciprocal += 1 / (position + 1);
  });
  return { recall5: hits / cases.length, mrr: reciprocal / cases.length, misses };
}

/**
 * A large course library is mostly ordinary prose that shares common words with every question.
 * These notes are generated deterministically from such words so the corpus has realistic noise;
 * they are never the relevant answer.
 */
function distractors(count: number) {
  const words = [
    '数据库',
    '事务',
    '索引',
    '查询',
    '系统',
    '学习',
    '课程',
    '实验',
    '需求',
    '测试',
    '设计',
    '模型',
    '上下文',
    '版本',
    '提交',
    '分支',
    '资料',
    '通知',
    '同学',
    '报名',
    '材料',
    '时间',
    '方法',
    '问题',
    '结果',
    '分析',
    '过程',
    '要求',
  ];
  const frames = [
    '本节讨论{0}与{1}的关系，并结合{2}说明常见的{3}。',
    '{0}是{1}中的重要{2}，同学们需要理解它对{3}的影响。',
    '在{0}之前，先检查{1}和{2}，再记录{3}。',
    '课程要求按时完成{0}，并在{1}中说明{2}和{3}。',
    '如果{0}出现{1}，需要回到{2}重新{3}。',
  ];
  let seed = 20261016;
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  return Array.from({ length: count }, (_, index) => ({
    id: 'noise-' + index,
    title: '课程笔记 ' + (index + 1),
    path: null,
    text: Array.from({ length: 18 + next(30) }, () =>
      frames[next(frames.length)]!.replace(/\{(\d)\}/g, () => words[next(words.length)]!),
    ).join(''),
  }));
}

describe.runIf(Boolean(url))('retrieval quality on fixed synthetic cases (PostgreSQL)', () => {
  let store: Store, cases: Cases;
  beforeAll(async () => {
    if (!new URL(url!).pathname.endsWith('_runtime_test')) throw new Error('Isolated runtime test DB required');
    cases = JSON.parse(await readFile('quality/retrieval-cases.json', 'utf8'));
    // RETRIEVAL_NOISE enlarges the library for a one-off latency measurement; the default keeps the suite quick.
    cases.documents.push(...distractors(Number(process.env.RETRIEVAL_NOISE) || 400));
    store = new Store(url!);
    await store.exec('DROP SCHEMA IF EXISTS app CASCADE');
    await store.migrate();
    for (const document of cases.documents)
      await store.transaction((tx) =>
        putSource(tx, {
          id: document.id,
          title: document.title,
          content: document.text,
          ...(document.path ? { path: document.path } : {}),
        }),
      );
    // A long-lived library has planner statistics; measure against that, not a just-loaded table.
    await store.exec('ANALYZE app.chunks, app.sources, app.source_versions');
  });
  afterAll(async () => {
    await store?.close();
  });

  it('tokenizes documents in TypeScript exactly as app.search_terms indexes them', async () => {
    const samples = [
      ...cases.documents.slice(0, 40).map((document) => document.text),
      '数据库 Index_B 事务ＡＢＣ１１月 a 𠀀𠀁 々〇 x9 _ __',
      '',
    ];
    for (const sample of samples) {
      const indexed = (await store.one('SELECT app.search_terms($1) AS terms', [sample]))!.terms as string[];
      expect([...indexed].sort()).toEqual(searchTerms(sample).sort());
    }
  });

  it('finds the relevant material at least as well as the previous search, with one SQL plan using the index', async () => {
    const fresh: string[][] = [],
      legacy: string[][] = [];
    let freshMs = 0,
      legacyMs = 0;
    for (const item of cases.queries) {
      let started = performance.now();
      fresh.push([...new Set((await retrieve(store, item.query, [], 10, undefined, 'errand')).map((c) => c.sourceId))]);
      freshMs += performance.now() - started;
      started = performance.now();
      legacy.push([...new Set((await legacyRetrieve(store, item.query, 10)).map((c) => c.sourceId))]);
      legacyMs += performance.now() - started;
    }
    const chunks = (await store.one('SELECT count(*)::int AS n FROM app.chunks'))!.n;
    const now = measure(fresh, cases.queries),
      before = measure(legacy, cases.queries);
    console.info(
      `检索基准（${cases.queries.length} 条查询，${cases.documents.length} 份资料，${chunks} 个片段）\n` +
        `  旧实现：recall@5 ${before.recall5.toFixed(3)}  MRR ${before.mrr.toFixed(3)}  平均 ${(legacyMs / cases.queries.length).toFixed(1)} ms  未命中：${before.misses.join('、') || '无'}\n` +
        `  新实现：recall@5 ${now.recall5.toFixed(3)}  MRR ${now.mrr.toFixed(3)}  平均 ${(freshMs / cases.queries.length).toFixed(1)} ms  未命中：${now.misses.join('、') || '无'}`,
    );
    expect(now.recall5).toBeGreaterThanOrEqual(before.recall5);
    expect(now.mrr).toBeGreaterThanOrEqual(before.mrr);
    expect(now.recall5).toBeGreaterThanOrEqual(0.9);
    // The candidate filter is an index lookup, not a scan of every chunk's text.
    await store.exec('SET enable_seqscan = off');
    const plan = (await store.rows("EXPLAIN SELECT id FROM app.chunks WHERE lexemes && ARRAY['奖学']::text[]")).map(
      (row) => Object.values(row)[0],
    );
    await store.exec('SET enable_seqscan = on');
    expect(plan.join('\n')).toContain('chunk_lexemes');
  });
});
