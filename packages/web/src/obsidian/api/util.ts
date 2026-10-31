import DOMPurify from 'dompurify';
import moment from 'moment';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { getAllTags as metaGetAllTags, type CachedMetadata, type Pos } from '../../vault/metadata';
import { parseLinktext as vaultParseLinktext, getLinkpath as vaultGetLinkpath } from '../../vault/linkResolver';
import { iconSvg, setIcon as iconsSetIcon, addIcon as iconsAddIcon, getIconIds as iconsGetIconIds } from '../../markdown/icons';

/** Free functions + constants of the `obsidian` module. */

export { moment };

export const apiVersion = '1.8.10';

export function requireApiVersion(version: string): boolean {
  const a = apiVersion.split('.').map(Number);
  const b = version.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: /Mac/.test(ua),
  isWin: /Win/.test(ua),
  isLinux: /Linux/.test(ua) && !/Android/.test(ua),
  isSafari: /Safari/.test(ua) && !/Chrome|Chromium/.test(ua),
  resourcePathPrefix: 'blob:',
};

/** Obsidian's normalizePath: forward slashes, no duplicates/edges, NFC. */
export function normalizePath(path: string): string {
  const p = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/ | /g, ' ')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .normalize('NFC');
  return p === '' ? '/' : p;
}

export interface Debouncer<T extends unknown[], V> {
  (...args: T): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | void;
}

export function debounce<T extends unknown[], V>(
  cb: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: T | null = null;
  const fire = (): V | void => {
    timer = null;
    if (!lastArgs) return;
    const args = lastArgs;
    lastArgs = null;
    return cb(...args);
  };
  const d = ((...args: T) => {
    lastArgs = args;
    if (timer && resetTimer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!timer) timer = setTimeout(fire, timeout);
    return d;
  }) as Debouncer<T, V>;
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    return d;
  };
  d.run = () => {
    if (timer) clearTimeout(timer);
    return fire();
  };
  return d;
}

export function getLanguage(): string {
  const l = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return l.split('-')[0] || 'en';
}

// ── YAML / front matter ─────────────────────────────────────────────────────
export function parseYaml(yaml: string): any {
  return yamlParse(yaml);
}
export function stringifyYaml(obj: unknown): string {
  return yamlStringify(obj);
}

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}
export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = /^---\r?\n([\s\S]*?)(\r?\n)?(?:---|\.\.\.)[ \t]*(\r?\n|$)/.exec(content);
  if (!m) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  const from = content.indexOf('\n') + 1;
  const to = from + m[1].length + (m[2] ? m[2].length : 0);
  return { exists: true, frontmatter: m[1], from, to: Math.max(from, to - (m[2] ? m[2].length : 0)), contentStart: m[0].length };
}

export function getAllTags(cache: CachedMetadata | null): string[] | null {
  return cache ? metaGetAllTags(cache) : null;
}

function splitList(v: unknown, sep: RegExp): string[] | null {
  if (v === null || v === undefined) return null;
  const list = Array.isArray(v) ? v.flatMap((x) => String(x ?? '').split(sep)) : String(v).split(sep);
  const out = list.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : null;
}
export function parseFrontMatterEntry(fm: any, key: string | RegExp): any | null {
  if (!fm) return null;
  for (const k of Object.keys(fm)) {
    if (typeof key === 'string' ? k === key : key.test(k)) return fm[k];
  }
  return null;
}
export function parseFrontMatterStringArray(fm: any, key: string | RegExp): string[] | null {
  return splitList(parseFrontMatterEntry(fm, key), /,/);
}
export function parseFrontMatterTags(fm: any): string[] | null {
  const t = splitList(parseFrontMatterEntry(fm, /^tags?$/i), /[,\s]+/);
  return t ? t.map((x) => (x.startsWith('#') ? x : `#${x}`)) : null;
}
export function parseFrontMatterAliases(fm: any): string[] | null {
  return splitList(parseFrontMatterEntry(fm, /^alias(es)?$/i), /,/);
}

// ── links ───────────────────────────────────────────────────────────────────
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  return vaultParseLinktext(linktext);
}
export function getLinkpath(linktext: string): string {
  return vaultGetLinkpath(linktext);
}
export function stripHeading(heading: string): string {
  return heading.replace(/[#|^\\%[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function stripHeadingForLink(heading: string): string {
  return stripHeading(heading);
}

export function resolveSubpath(cache: CachedMetadata, subpath: string): any | null {
  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2);
    const block = cache.blocks?.[id];
    if (!block) return null;
    const list = cache.listItems?.find((l) => l.id === id);
    return { type: 'block', block, list, start: block.position.start, end: block.position.end };
  }
  const parts = subpath.replace(/^#/, '').split('#').map((s) => stripHeading(s).toLowerCase());
  const hs = cache.headings ?? [];
  let idx = -1;
  let from = 0;
  for (const part of parts) {
    idx = hs.findIndex((h, i) => i >= from && stripHeading(h.heading).toLowerCase() === part);
    if (idx < 0) return null;
    from = idx + 1;
  }
  const current = hs[idx];
  const next = hs.slice(idx + 1).find((h) => h.level <= current.level) ?? null;
  return { type: 'heading', current, next, start: current.position.start, end: next ? next.position.start : null };
}

export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: any) => boolean | void): boolean {
  for (const r of [...(cache.links ?? []), ...(cache.embeds ?? [])]) if (cb(r)) return true;
  return false;
}
export function iterateRefs(refs: any[], cb: (ref: any) => boolean | void): boolean {
  for (const r of refs) if (cb(r)) return true;
  return false;
}

// ── search ──────────────────────────────────────────────────────────────────
export interface SearchResult {
  score: number;
  matches: Array<[number, number]>;
}
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  return (text: string) => {
    if (!q) return { score: 0, matches: [] };
    const t = text.toLowerCase();
    const matches: Array<[number, number]> = [];
    let ti = 0;
    let score = 0;
    let last = -2;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found < 0) return null;
      if (found === last + 1 && matches.length) matches[matches.length - 1][1] = found + 1;
      else matches.push([found, found + 1]);
      score -= found - ti; // gaps cost
      last = found;
      ti = found + 1;
    }
    if (t.startsWith(q)) score += 10;
    return { score: score - text.length * 0.01, matches };
  };
}
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text: string) => {
    const t = text.toLowerCase();
    const matches: Array<[number, number]> = [];
    for (const w of words) {
      const i = t.indexOf(w);
      if (i < 0) return null;
      matches.push([i, i + w.length]);
    }
    return { score: -matches.reduce((s, m) => s + m[0], 0), matches: matches.sort((a, b) => a[0] - b[0]) };
  };
}
export function fuzzySearch(q: { query: string } | string, text: string): SearchResult | null {
  return prepareFuzzySearch(typeof q === 'string' ? q : q.query)(text);
}
export function sortSearchResults(results: Array<{ match: SearchResult }>): void {
  results.sort((a, b) => b.match.score - a.match.score);
}
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: Array<[number, number]> | null, offset = 0): void {
  let pos = 0;
  for (const [s0, e0] of matches ?? []) {
    const s = s0 + offset;
    const e = e0 + offset;
    if (s < pos) continue;
    if (s > pos) el.appendText(text.slice(pos, s));
    el.createSpan({ cls: 'suggestion-highlight', text: text.slice(s, e) });
    pos = e;
  }
  if (pos < text.length) el.appendText(text.slice(pos));
}
export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number): void {
  renderMatches(el, text, result.matches, offset);
}

// ── HTML ────────────────────────────────────────────────────────────────────
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as unknown as DocumentFragment;
}

/** A compact HTML → Markdown converter (Obsidian bundles Turndown for this). */
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  let root: Node;
  if (typeof html === 'string') root = sanitizeHTMLToDom(html);
  else root = html;
  const walk = (n: Node, ctx: { list: string[]; pre: boolean }): string => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? '';
      return ctx.pre ? t : t.replace(/\s+/g, ' ');
    }
    if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && n.nodeType !== Node.DOCUMENT_NODE) {
      return '';
    }
    const el = n as HTMLElement;
    const tag = el.tagName?.toLowerCase() ?? '';
    const kids = (c = ctx): string => Array.from(n.childNodes).map((k) => walk(k, c)).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
      case 'p': case 'div': case 'section': case 'article':
        return `\n\n${kids().trim()}\n\n`;
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'strong': case 'b':
        return `**${kids()}**`;
      case 'em': case 'i':
        return `*${kids()}*`;
      case 'del': case 's':
        return `~~${kids()}~~`;
      case 'mark':
        return `==${kids()}==`;
      case 'code':
        return ctx.pre ? kids() : `\`${kids()}\``;
      case 'pre':
        return `\n\n\`\`\`\n${kids({ ...ctx, pre: true }).replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'a': {
        const href = el.getAttribute('href') ?? '';
        const text = kids();
        return href ? `[${text}](${href})` : text;
      }
      case 'img':
        return `![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`;
      case 'ul': case 'ol': {
        const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'li');
        const indent = '    '.repeat(ctx.list.length);
        return `\n${items
          .map((li, i) => `${indent}${tag === 'ol' ? `${i + 1}.` : '-'} ${walk(li, { ...ctx, list: [...ctx.list, tag] }).trim()}`)
          .join('\n')}\n`;
      }
      case 'blockquote':
        return `\n\n${kids().trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'table': {
        const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.children).map((c) => walk(c, ctx).trim().replace(/\|/g, '\\|')),
        );
        if (!rows.length) return '';
        const head = rows[0];
        const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
        return `\n\n${lines.join('\n')}\n\n`;
      }
      case 'script': case 'style':
        return '';
      default:
        return kids();
    }
  };
  return walk(root, { list: [], pre: false }).replace(/\n{3,}/g, '\n\n').trim();
}

// ── network ─────────────────────────────────────────────────────────────────
export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}
export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}
/**
 * requestUrl over fetch. Unlike Obsidian's (Electron) version this is subject
 * to the browser's CORS rules.
 */
export function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> & {
  json: Promise<any>;
  text: Promise<string>;
  arrayBuffer: Promise<ArrayBuffer>;
} {
  const req = typeof request === 'string' ? { url: request } : request;
  const p = (async (): Promise<RequestUrlResponse> => {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.contentType) headers['Content-Type'] = req.contentType;
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers, body: req.body as BodyInit | undefined });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    const out = { status: res.status, headers: h, arrayBuffer: buf, json, text };
    if ((req.throw ?? true) && res.status >= 400) {
      const err = new Error(`Request failed, status ${res.status}`) as Error & RequestUrlResponse;
      Object.assign(err, out);
      throw err;
    }
    return out;
  })();
  return Object.assign(p, {
    get json() {
      return p.then((r) => r.json);
    },
    get text() {
      return p.then((r) => r.text);
    },
    get arrayBuffer() {
      return p.then((r) => r.arrayBuffer);
    },
  }) as never;
}
export async function request(req: RequestUrlParam | string): Promise<string> {
  return (await requestUrl(req)).text;
}

// ── binary helpers ──────────────────────────────────────────────────────────
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
export function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

// ── icons / tooltips ────────────────────────────────────────────────────────
export function setIcon(el: HTMLElement, iconId: string): void {
  iconsSetIcon(el, iconId);
}
export function addIcon(iconId: string, svgContent: string): void {
  iconsAddIcon(iconId, svgContent);
}
export function getIcon(iconId: string): SVGSVGElement | null {
  const svg = iconSvg(iconId);
  if (!svg) return null;
  const t = document.createElement('template');
  t.innerHTML = svg;
  return t.content.firstElementChild as SVGSVGElement;
}
export function getIconIds(): string[] {
  return iconsGetIconIds();
}
export function setTooltip(el: HTMLElement, tooltip: string, _options?: unknown): void {
  if (tooltip) el.setAttribute('aria-label', tooltip);
  el.setAttribute('title', tooltip);
}
export function displayTooltip(newTargetEl: HTMLElement, content: string | DocumentFragment, _options?: unknown): void {
  const text = typeof content === 'string' ? content : content.textContent ?? '';
  newTargetEl.setAttribute('title', text);
}

// ── misc ────────────────────────────────────────────────────────────────────
export async function loadMermaid(): Promise<any> {
  return (await import('mermaid')).default;
}
export async function loadMathJax(): Promise<void> {}
export async function loadPdfJs(): Promise<any> {
  throw new Error('PDF.js is not available in the web app');
}
export async function loadPrism(): Promise<any> {
  return null;
}
export function renderMath(source: string, display: boolean): HTMLElement {
  const el = document.createElement(display ? 'div' : 'span');
  el.className = `math math-${display ? 'block' : 'inline'}`;
  el.setAttribute('data-tex', source);
  el.textContent = source;
  void import('katex').then(({ default: katex }) => {
    try {
      katex.render(source, el, { displayMode: display, throwOnError: false });
    } catch {
      /* keep source */
    }
  });
  return el;
}
export async function finishRenderMath(): Promise<void> {}

export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

export type { Pos };
