import type { Row } from '../../storage/src/index.js';

// Han characters as PostgreSQL's app.search_terms (migration 0017) matches them, code point ranges only.
const HAN =
  '\\u2e80-\\u2fdf\\u3005\\u3007\\u3021-\\u3029\\u3038-\\u303b\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{3134f}';
const TOKEN = new RegExp(`[a-z0-9_]{2,}|[${HAN}]+`, 'gu');
const ASCII = /^[a-z0-9_]+$/;
const fold = (text: string) => text.normalize('NFKC').toLowerCase();

/**
 * The TypeScript mirror of app.search_terms. Documents index every Han bigram and single character;
 * a query keeps single characters only where it wrote one on its own, so "数据库" asks for 数据 and
 * 据库 rather than three very common characters.
 */
export function searchTerms(text: string, query = false) {
  const terms = new Set<string>();
  for (const token of fold(text).match(TOKEN) || []) {
    if (ASCII.test(token)) {
      terms.add(token);
      continue;
    }
    const characters = [...token];
    for (let index = 0; index + 1 < characters.length; index++) terms.add(characters[index]! + characters[index + 1]!);
    if (!query || characters.length === 1) for (const character of characters) terms.add(character);
  }
  return [...terms];
}

export type TermStats = { documents: number; averageLength: number; frequency: Map<string, number> };
const K1 = 1.2,
  B = 0.75;
/** Probabilistic IDF as in BM25, kept positive for terms that appear in most chunks. */
export const idf = (stats: TermStats, term: string) => {
  const df = stats.frequency.get(term) ?? 0;
  return Math.log(1 + (stats.documents - df + 0.5) / (df + 0.5));
};

/**
 * Query terms worth searching for, rarest first. Terms no chunk contains are dropped; in a corpus
 * of 20 or more chunks, terms found in over half of them are dropped as well, unless nothing else
 * is left. The order is by information, not by position in the query, so a long notice or task
 * no longer loses its opening words.
 */
export function selectTerms(stats: TermStats, terms: string[], limit = 64) {
  const present = terms.filter((term) => (stats.frequency.get(term) ?? 0) > 0);
  const ranked = present.sort((a, b) => idf(stats, b) - idf(stats, a) || a.localeCompare(b));
  const informative =
    stats.documents >= 20 ? ranked.filter((term) => stats.frequency.get(term)! / stats.documents <= 0.5) : ranked;
  return (informative.length ? informative : ranked.slice(0, 4)).slice(0, limit);
}
/**
 * The rarest terms whose chunks together stay within `budget`; only these filter candidates through
 * the index, while every selected term still counts in the score.
 */
export function candidateTerms(stats: TermStats, selected: string[], budget = 600) {
  const chosen: string[] = [];
  let total = 0;
  for (const term of selected) {
    const df = stats.frequency.get(term)!;
    if (chosen.length && total + df > budget) break;
    chosen.push(term);
    total += df;
  }
  return chosen;
}
function occurrences(text: string, term: string) {
  let count = 0;
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + term.length)) count++;
  return count;
}
/** BM25 over the chunks' own text, normalised the same way as the index. */
export function rankBM25<T extends Row>(rows: T[], stats: TermStats, terms: string[]) {
  const weights = terms.map((term) => [term, idf(stats, term)] as const);
  return rows
    .map((row) => {
      const text = fold(row.content as string),
        length = [...text].length;
      let score = 0;
      for (const [term, weight] of weights) {
        const tf = occurrences(text, term);
        if (tf)
          score += (weight * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / Math.max(1, stats.averageLength)));
      }
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.row.source_id).localeCompare(String(b.row.source_id)) ||
        a.row.start_offset - b.row.start_offset,
    );
}
