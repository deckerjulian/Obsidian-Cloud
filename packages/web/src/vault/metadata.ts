import { parse as parseYamlText } from 'yaml';

/**
 * A line-based Markdown scanner producing Obsidian's `CachedMetadata` shape
 * (headings, links, embeds, tags, sections, list items, block ids, front
 * matter, all with positions). It powers backlinks/outline/search in the web
 * app and is what `app.metadataCache.getFileCache()` returns to plugins
 * (Dataview builds its index from exactly these fields).
 */

export interface Loc {
  line: number;
  col: number;
  offset: number;
}
export interface Pos {
  start: Loc;
  end: Loc;
}
export interface LinkCache {
  link: string;
  original: string;
  displayText?: string;
  position: Pos;
}
export interface TagCache {
  tag: string;
  position: Pos;
}
export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}
export type SectionType =
  | 'yaml'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'code'
  | 'blockquote'
  | 'callout'
  | 'table'
  | 'thematicBreak'
  | 'html'
  | 'math'
  | 'comment'
  | 'footnoteDefinition';
export interface SectionCache {
  type: SectionType;
  position: Pos;
  id?: string;
}
export interface ListItemCache {
  /** Line of the parent item; negative (−(list start line + 1)) for roots. */
  parent: number;
  /** Task status character (' ', 'x', …) when this item is a task. */
  task?: string;
  position: Pos;
  id?: string;
}
export interface BlockCache {
  id: string;
  position: Pos;
}
export interface FrontmatterLinkCache {
  key: string;
  link: string;
  original: string;
  displayText?: string;
}
export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: LinkCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: Record<string, unknown>;
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
}

export function parseYaml(text: string): unknown {
  return parseYamlText(text);
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^([ \t]*)(?:>[ \t]?)*([-*+]|\d+[.)])[ \t]+(?:\[(.)\][ \t]+)?/;
const LIST_ITEM_START = /^([ \t]*)([-*+]|\d+[.)])([ \t]+|$)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const WIKILINK = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
// Obsidian tags: '#' + letters/digits/_/-// (not purely numeric), preceded by
// start or whitespace. Unicode letters are allowed (e.g. #Prüfung).
const TAG = /(^|[\s(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/** Split `target|alias` and return Obsidian's link fields. */
function wikiParts(inner: string): { link: string; displayText: string } {
  const pipe = inner.indexOf('|');
  const link = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const displayText = pipe >= 0 ? inner.slice(pipe + 1) : link;
  return { link, displayText };
}

/** Blank out inline code spans (keeping offsets) so links/tags inside them are ignored. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)([^`]|(?!\1)`)*?\1/g, (m) => ' '.repeat(m.length));
}

export function parseMetadata(text: string): CachedMetadata {
  const lines = text.split('\n');
  const lineStart: number[] = [];
  {
    let off = 0;
    for (const l of lines) {
      lineStart.push(off);
      off += l.length + 1;
    }
  }
  const loc = (line: number, col: number): Loc => ({ line, col, offset: lineStart[line] + col });
  const span = (l1: number, c1: number, l2: number, c2: number): Pos => ({ start: loc(l1, c1), end: loc(l2, c2) });
  const lineSpan = (l1: number, l2: number): Pos => span(l1, 0, l2, lines[l2].length);

  const md: CachedMetadata = {};
  const links: LinkCache[] = [];
  const embeds: LinkCache[] = [];
  const tags: TagCache[] = [];
  const headings: HeadingCache[] = [];
  const sections: SectionCache[] = [];
  const listItems: ListItemCache[] = [];
  const blocks: Record<string, BlockCache> = {};

  let i = 0;
  // ── front matter ──
  if (lines[0]?.trimEnd() === '---') {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].trimEnd();
      if (t === '---' || t === '...') {
        end = j;
        break;
      }
    }
    if (end > 0) {
      const pos = lineSpan(0, end);
      md.frontmatterPosition = pos;
      sections.push({ type: 'yaml', position: pos });
      try {
        const fm = parseYaml(lines.slice(1, end).join('\n'));
        if (fm && typeof fm === 'object' && !Array.isArray(fm)) {
          md.frontmatter = fm as Record<string, unknown>;
          const fmLinks: FrontmatterLinkCache[] = [];
          const visit = (key: string, v: unknown): void => {
            if (typeof v === 'string') {
              for (const m of v.matchAll(WIKILINK)) {
                const { link, displayText } = wikiParts(m[2]);
                fmLinks.push({ key, link, original: m[0], displayText });
              }
            } else if (Array.isArray(v)) v.forEach((x, k) => visit(`${key}.${k}`, x));
          };
          for (const [k, v] of Object.entries(md.frontmatter)) visit(k, v);
          if (fmLinks.length) md.frontmatterLinks = fmLinks;
          const fmTags = md.frontmatter.tags ?? md.frontmatter.tag;
          const tagList = Array.isArray(fmTags)
            ? fmTags
            : typeof fmTags === 'string'
              ? fmTags.split(/[,\s]+/)
              : [];
          void tagList; // front-matter tags are exposed via getAllTags(), not `tags`
        }
      } catch {
        /* invalid YAML: Obsidian keeps the section but no frontmatter */
      }
      i = end + 1;
    }
  }

  /** Scan one line of prose for links, embeds, tags and a trailing block id. */
  const scanInline = (ln: number): void => {
    const raw = lines[ln];
    const masked = maskInlineCode(raw);
    for (const m of masked.matchAll(WIKILINK)) {
      const col = m.index!;
      const { link, displayText } = wikiParts(m[2]);
      const entry: LinkCache = {
        link,
        original: raw.slice(col, col + m[0].length),
        displayText,
        position: span(ln, col, ln, col + m[0].length),
      };
      (m[1] ? embeds : links).push(entry);
    }
    for (const m of masked.matchAll(MDLINK)) {
      let target = m[3].trim();
      const title = / +"[^"]*"$/.exec(target);
      if (title) target = target.slice(0, title.index);
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (isExternal(target) || target.startsWith('#') === false && target === '') continue;
      let decoded = target;
      try {
        decoded = decodeURI(target);
      } catch {
        /* keep raw */
      }
      const col = m.index!;
      const entry: LinkCache = {
        link: decoded,
        original: raw.slice(col, col + m[0].length),
        displayText: m[2],
        position: span(ln, col, ln, col + m[0].length),
      };
      (m[1] ? embeds : links).push(entry);
    }
    // Tags: not inside links or URLs.
    const noLinks = masked.replace(WIKILINK, (s) => ' '.repeat(s.length)).replace(MDLINK, (s) => ' '.repeat(s.length));
    for (const m of noLinks.matchAll(TAG)) {
      const col = m.index! + m[1].length;
      tags.push({ tag: `#${m[2]}`, position: span(ln, col, ln, col + m[2].length + 1) });
    }
  };

  const blockIdOf = (ln: number): string | undefined => BLOCK_ID.exec(lines[ln])?.[1];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') {
      i++;
      continue;
    }
    // ── fenced code ──
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(marker[0].repeat(marker.length))) j++;
      const end = Math.min(j, lines.length - 1);
      sections.push({ type: 'code', position: lineSpan(i, end) });
      i = end + 1;
      continue;
    }
    // ── math / comment blocks ──
    if (trimmed.startsWith('$$') || trimmed.startsWith('%%')) {
      const tok = trimmed.slice(0, 2);
      let end = i;
      if (!(trimmed.length > 2 && trimmed.endsWith(tok))) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes(tok)) j++;
        end = Math.min(j, lines.length - 1);
      }
      sections.push({ type: tok === '$$' ? 'math' : 'comment', position: lineSpan(i, end) });
      i = end + 1;
      continue;
    }
    // ── heading ──
    const h = HEADING.exec(line);
    if (h) {
      const pos = lineSpan(i, i);
      headings.push({ heading: h[2].trim(), level: h[1].length, position: pos });
      sections.push({ type: 'heading', position: pos });
      scanInline(i);
      i++;
      continue;
    }
    if (HR.test(line)) {
      sections.push({ type: 'thematicBreak', position: lineSpan(i, i) });
      i++;
      continue;
    }
    // ── blockquote / callout ──
    if (trimmed.startsWith('>')) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].trim().startsWith('>')) j++;
      const type: SectionType = /^>\s*\[![^\]]+\]/.test(trimmed) ? 'callout' : 'blockquote';
      const sec: SectionCache = { type, position: lineSpan(i, j) };
      for (let k = i; k <= j; k++) scanInline(k);
      // List items inside callouts are tracked too (Obsidian does).
      collectList(i, j, true);
      const id = blockIdOf(j);
      if (id) {
        sec.id = id;
        blocks[id] = { id, position: sec.position };
      }
      sections.push(sec);
      i = j + 1;
      continue;
    }
    // ── list ──
    if (LIST_ITEM_START.test(line)) {
      let j = i;
      while (j + 1 < lines.length) {
        const next = lines[j + 1];
        if (next.trim() === '') {
          // A blank line continues the list only if an indented/list line follows.
          const after = lines[j + 2];
          if (after !== undefined && (LIST_ITEM_START.test(after) || /^[ \t]+\S/.test(after))) {
            j += 1;
            continue;
          }
          break;
        }
        if (LIST_ITEM_START.test(next) || /^[ \t]+\S/.test(next)) {
          j++;
          continue;
        }
        // Lazy continuation of the previous item's paragraph.
        if (!HEADING.test(next) && !FENCE.test(next) && !next.trim().startsWith('>') && !HR.test(next)) {
          j++;
          continue;
        }
        break;
      }
      while (j > i && lines[j].trim() === '') j--;
      sections.push({ type: 'list', position: lineSpan(i, j) });
      for (let k = i; k <= j; k++) scanInline(k);
      collectList(i, j, false);
      i = j + 1;
      continue;
    }
    // ── table ──
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      let j = i + 1;
      while (j + 1 < lines.length && lines[j + 1].includes('|') && lines[j + 1].trim() !== '') j++;
      sections.push({ type: 'table', position: lineSpan(i, j) });
      for (let k = i; k <= j; k++) scanInline(k);
      i = j + 1;
      continue;
    }
    // ── html block ──
    if (/^<[a-zA-Z!/]/.test(trimmed)) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].trim() !== '') j++;
      sections.push({ type: 'html', position: lineSpan(i, j) });
      i = j + 1;
      continue;
    }
    // ── footnote definition ──
    if (/^\[\^[^\]]+\]:/.test(trimmed)) {
      sections.push({ type: 'footnoteDefinition', position: lineSpan(i, i) });
      scanInline(i);
      i++;
      continue;
    }
    // ── paragraph ──
    let j = i;
    while (
      j + 1 < lines.length &&
      lines[j + 1].trim() !== '' &&
      !HEADING.test(lines[j + 1]) &&
      !FENCE.test(lines[j + 1]) &&
      !lines[j + 1].trim().startsWith('>') &&
      !LIST_ITEM_START.test(lines[j + 1]) &&
      !HR.test(lines[j + 1])
    )
      j++;
    const sec: SectionCache = { type: 'paragraph', position: lineSpan(i, j) };
    for (let k = i; k <= j; k++) scanInline(k);
    const id = blockIdOf(j);
    if (id) {
      sec.id = id;
      blocks[id] = { id, position: sec.position };
    }
    sections.push(sec);
    i = j + 1;
  }

  /** List items (with parent lines + task status) for lines [from, to]. */
  function collectList(from: number, to: number, quoted: boolean): void {
    const stack: Array<{ indent: number; line: number; idx: number }> = [];
    const rootParent = -(from + 1);
    let current: ListItemCache | null = null;
    for (let k = from; k <= to; k++) {
      let l = lines[k];
      if (quoted) l = l.replace(/^\s*(>\s?)+/, '');
      const m = LIST.exec(l);
      const isItem = m !== null && LIST_ITEM_START.test(l);
      if (!isItem) {
        if (current && l.trim() !== '') current.position = { start: current.position.start, end: loc(k, lines[k].length) };
        continue;
      }
      const indent = m![1].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].line : rootParent;
      const item: ListItemCache = { parent, position: lineSpan(k, k) };
      if (m![3] !== undefined) item.task = m![3];
      const id = blockIdOf(k);
      if (id) {
        item.id = id;
        blocks[id] = { id, position: item.position };
      }
      listItems.push(item);
      stack.push({ indent, line: k, idx: listItems.length - 1 });
      current = item;
    }
  }

  if (links.length) md.links = links;
  if (embeds.length) md.embeds = embeds;
  if (tags.length) md.tags = tags;
  if (headings.length) md.headings = headings;
  if (sections.length) md.sections = sections;
  if (listItems.length) md.listItems = listItems;
  if (Object.keys(blocks).length) md.blocks = blocks;
  return md;
}

/** All tags of a note: inline tags plus front-matter `tags`/`tag` (Obsidian's getAllTags). */
export function getAllTags(cache: CachedMetadata): string[] {
  const out: string[] = (cache.tags ?? []).map((t) => t.tag);
  const fm = cache.frontmatter;
  if (fm) {
    for (const key of Object.keys(fm)) {
      if (!/^tags?$/i.test(key)) continue;
      const v = fm[key];
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
      for (const t of list) {
        const s = String(t ?? '').trim();
        if (s) out.push(s.startsWith('#') ? s : `#${s}`);
      }
    }
  }
  return out;
}
