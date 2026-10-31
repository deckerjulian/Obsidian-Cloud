import type { InlineContext, MarkdownConfig } from '@lezer/markdown';
import { Tag, tags as t } from '@lezer/highlight';

/**
 * Obsidian's Markdown dialect on top of CommonMark + GFM, as Lezer inline
 * parsers: [[wikilinks]], ![[embeds]], ==highlights==, #tags, $math$ and
 * %%comments%%. Gives the editor (source mode and Live Preview) a syntax tree
 * that knows these constructs — and never finds them inside code.
 */

export const obsidianTags = {
  highlight: Tag.define(),
  math: Tag.define(),
  hashtag: Tag.define(),
  internalLink: Tag.define(t.link),
};

const C = { bang: 33, hash: 35, dollar: 36, pct: 37, eq: 61, open: 91, close: 93, pipe: 124, nl: 10 };
const isSpace = (s: string): boolean => /^\s?$/.test(s);
const TAG_CHAR = /[\p{L}\p{N}_/-]/u;

/** End of `[[…]]` starting at `start` (index after `]]`), or -1. */
function wikiEnd(cx: InlineContext, start: number): number {
  for (let i = start; i < cx.end - 1; i++) {
    const c = cx.char(i);
    if (c === C.nl || c === C.open) return -1;
    if (c === C.close) return cx.char(i + 1) === C.close && i > start ? i + 2 : -1;
  }
  return -1;
}

function wikiChildren(cx: InlineContext, start: number, markEnd: number, end: number) {
  const inner = cx.slice(markEnd, end - 2);
  const pipe = inner.indexOf('|');
  const children = [cx.elt('WikiMark', start, markEnd)];
  if (pipe < 0) children.push(cx.elt('WikiTarget', markEnd, end - 2));
  else {
    children.push(cx.elt('WikiTarget', markEnd, markEnd + pipe));
    children.push(cx.elt('WikiMark', markEnd + pipe, markEnd + pipe + 1));
    if (pipe + 1 < inner.length) children.push(cx.elt('WikiAlias', markEnd + pipe + 1, end - 2));
  }
  children.push(cx.elt('WikiMark', end - 2, end));
  return children;
}

/** Find `marker` (same line) after `from`; returns its index or -1. */
function findOnLine(cx: InlineContext, from: number, marker: string): number {
  const rest = cx.slice(from, cx.end);
  const nl = rest.indexOf('\n');
  const idx = (nl < 0 ? rest : rest.slice(0, nl)).indexOf(marker);
  return idx < 0 ? -1 : from + idx;
}

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const obsidianMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: obsidianTags.internalLink },
    { name: 'WikiEmbed', style: obsidianTags.internalLink },
    { name: 'WikiMark', style: t.processingInstruction },
    { name: 'WikiTarget' },
    { name: 'WikiAlias' },
    { name: 'Highlight', style: obsidianTags.highlight },
    { name: 'HighlightMark', style: t.processingInstruction },
    { name: 'InlineMath', style: obsidianTags.math },
    { name: 'MathMark', style: t.processingInstruction },
    { name: 'Hashtag', style: obsidianTags.hashtag },
    { name: 'ObsidianComment', style: t.comment },
  ],
  parseInline: [
    {
      name: 'WikiEmbed',
      before: 'Image',
      parse(cx, next, pos) {
        if (next !== C.bang || cx.char(pos + 1) !== C.open || cx.char(pos + 2) !== C.open) return -1;
        const end = wikiEnd(cx, pos + 3);
        if (end < 0) return -1;
        return cx.addElement(cx.elt('WikiEmbed', pos, end, wikiChildren(cx, pos, pos + 3, end)));
      },
    },
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== C.open || cx.char(pos + 1) !== C.open) return -1;
        const end = wikiEnd(cx, pos + 2);
        if (end < 0) return -1;
        return cx.addElement(cx.elt('WikiLink', pos, end, wikiChildren(cx, pos, pos + 2, end)));
      },
    },
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== C.eq || cx.char(pos + 1) !== C.eq || cx.char(pos + 2) === C.eq) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !isSpace(after), !isSpace(before));
      },
    },
    {
      name: 'ObsidianComment',
      parse(cx, next, pos) {
        if (next !== C.pct || cx.char(pos + 1) !== C.pct) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf('%%');
        if (close < 0) return -1;
        return cx.addElement(cx.elt('ObsidianComment', pos, pos + 2 + close + 2));
      },
    },
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== C.dollar) return -1;
        const display = cx.char(pos + 1) === C.dollar;
        const m = display ? 2 : 1;
        const first = cx.slice(pos + m, pos + m + 1);
        if (!first || /\s|\$/.test(first)) return -1;
        let close = findOnLine(cx, pos + m + 1, display ? '$$' : '$');
        while (close > 0 && !display && cx.slice(close - 1, close) === '\\') close = findOnLine(cx, close + 1, '$');
        if (close < 0 || /\s/.test(cx.slice(close - 1, close))) return -1;
        if (!display && /\d/.test(cx.slice(close + 1, close + 2))) return -1;
        const end = close + m;
        return cx.addElement(
          cx.elt('InlineMath', pos, end, [cx.elt('MathMark', pos, pos + m), cx.elt('MathMark', close, end)]),
        );
      },
    },
    {
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== C.hash || !isSpace(cx.slice(pos - 1, pos))) return -1;
        let end = pos + 1;
        while (end < cx.end && TAG_CHAR.test(cx.slice(end, end + 1))) end++;
        const body = cx.slice(pos + 1, end);
        if (!body || /^\d+$/.test(body)) return -1;
        return cx.addElement(cx.elt('Hashtag', pos, end));
      },
    },
  ],
};
