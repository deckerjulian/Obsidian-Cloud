/**
 * Small fuzzy matcher for the quick switcher / command palette: every query
 * character must appear in order; contiguous runs, word starts and early
 * matches score higher. Returns matched indices for highlighting.
 */
export interface FuzzyMatch {
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    indices.push(i);
    if (i === prev + 1) score += 5; // contiguous
    if (i === 0 || /[\s/_\-.]/.test(t[i - 1])) score += 3; // word start
    score -= Math.min(i - ti, 10) * 0.1; // gap penalty
    prev = i;
    ti = i + 1;
  }
  if (t.includes(query.toLowerCase().trim())) score += 10; // substring bonus
  score -= text.length * 0.01;
  return { score, indices };
}

/** Rank items by fuzzy score (best first); drops non-matches. */
export function fuzzySort<T>(query: string, items: T[], key: (item: T) => string, limit = 50): Array<{ item: T; match: FuzzyMatch }> {
  const out: Array<{ item: T; match: FuzzyMatch }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}
