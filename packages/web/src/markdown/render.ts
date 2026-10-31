import DOMPurify from 'dompurify';
import type { Token, TokensList } from 'marked';
import { obsidianMarked, splitFrontmatter } from './obsidianMarkdown';
import { CALLOUTS, iconSvg } from './icons';
import { parseYaml } from '../vault/metadata';
import { parseLinktext } from '../vault/linkResolver';
import type { VaultStore, VFile } from '../vault/VaultStore';

/**
 * Obsidian-style reading view renderer. Produces the same DOM Obsidian does
 * (`markdown-preview-section` > one div per block, `callout`, `internal-link`,
 * `internal-embed`, `block-language-*`), resolves links/embeds against the
 * decrypted vault, and runs the registered code-block processors and
 * post-processors — which is how community plugins (Dataview, …) hook in.
 */

export interface SectionInfo {
  text: string;
  lineStart: number;
  lineEnd: number;
}
export interface PostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: Record<string, unknown> | null | undefined;
  addChild(child: { load?(): void; unload?(): void; onload?(): void }): void;
  getSectionInfo(el: HTMLElement): SectionInfo | null;
}
export type CodeBlockProcessor = (source: string, el: HTMLElement, ctx: PostProcessorContext) => unknown;
export interface PostProcessorEntry {
  fn: (el: HTMLElement, ctx: PostProcessorContext) => unknown;
  sortOrder: number;
}

/** Global registries the plugin host fills (Obsidian's are global too). */
export const markdownHooks = {
  codeBlockProcessors: new Map<string, CodeBlockProcessor>(),
  postProcessors: [] as PostProcessorEntry[],
};

export interface RenderOptions {
  store: VaultStore | null;
  sourcePath: string;
  /** Called for internal-link clicks. */
  onOpenLink?: (linktext: string, sourcePath: string, newLeaf: boolean) => void;
  /** Receives components created by processors (unloaded with the view). */
  addChild?: (child: { load?(): void; unload?(): void; onload?(): void }) => void;
  /** Render front matter as a properties table (top-level notes only). */
  showProperties?: boolean;
  /** Embed recursion depth (internal). */
  depth?: number;
  /** Toggle a task checkbox at the given source line. */
  onToggleTask?: (line: number, checked: boolean) => void;
}

let defaultLinkHandler: RenderOptions['onOpenLink'];
/** The workspace installs its navigation here (used by plugin renders too). */
export function setDefaultLinkHandler(fn: RenderOptions['onOpenLink']): void {
  defaultLinkHandler = fn;
}

const MAX_EMBED_DEPTH = 4;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', '3gp']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'ogv']);

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'src', 'alt'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
  });
}

/** Render the front matter as Obsidian's (read-only) properties block. */
function renderProperties(yaml: string, el: HTMLElement): void {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return;
  const box = el.createDiv({ cls: 'metadata-container' });
  box.createDiv({ cls: 'metadata-properties-heading', text: 'Eigenschaften' });
  const props = box.createDiv({ cls: 'metadata-properties' });
  for (const [k, v] of entries) {
    const row = props.createDiv({ cls: 'metadata-property', attr: { 'data-property-key': k } });
    row.createDiv({ cls: 'metadata-property-key', text: k });
    const val = row.createDiv({ cls: 'metadata-property-value' });
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) {
      const s = item instanceof Date ? item.toISOString().slice(0, 10) : item === null ? '' : String(item);
      if (/^tags?$/i.test(k)) {
        val.createEl('a', { cls: 'tag', text: s.startsWith('#') ? s : `#${s}`, href: `#${s.replace(/^#/, '')}` });
      } else {
        const m = /^\[\[([^\]]+)\]\]$/.exec(s);
        if (m) {
          const [target, alias] = m[1].split('|');
          val.createEl('a', { cls: 'internal-link', text: alias ?? target, attr: { 'data-href': target, href: target } });
        } else val.createSpan({ cls: 'metadata-property-pill', text: s });
      }
    }
  }
}

/** Turn `> [!type]± Title` blockquotes into Obsidian callouts (recursively). */
function buildCallouts(root: HTMLElement): void {
  for (const bq of Array.from(root.querySelectorAll('blockquote')).reverse()) {
    const first = bq.firstElementChild;
    if (!first || first.tagName !== 'P') continue;
    const html = first.innerHTML;
    const m = /^\s*\[!([^\]\s]+)\]([+-]?)[ \t]*([^\n<]*(?:<(?!br)[^>]*>[^\n<]*)*)/.exec(html);
    if (!m) continue;
    const type = m[1].toLowerCase();
    const fold = m[2];
    const restIdx = m[0].length;
    let after = html.slice(restIdx);
    after = after.replace(/^\s*<br\s*\/?>\s*\n?/, '').replace(/^\n/, '');
    const titleHtml = m[3].trim();
    const def = CALLOUTS[type] ?? CALLOUTS.note;

    const callout = document.createElement('div');
    callout.className = `callout${fold ? ' is-collapsible' : ''}${fold === '-' ? ' is-collapsed' : ''}`;
    callout.setAttribute('data-callout', type);
    callout.setAttribute('data-callout-metadata', '');
    callout.setAttribute('data-callout-fold', fold);
    callout.style.setProperty('--callout-color', def.color);
    const title = callout.createDiv({ cls: 'callout-title' });
    const icon = title.createDiv({ cls: 'callout-icon' });
    icon.innerHTML = iconSvg(def.icon, 18) ?? '';
    const inner = title.createDiv({ cls: 'callout-title-inner' });
    if (titleHtml) inner.innerHTML = titleHtml;
    else inner.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    const content = callout.createDiv({ cls: 'callout-content' });
    if (fold) {
      const chev = title.createDiv({ cls: `callout-fold${fold === '-' ? ' is-collapsed' : ''}` });
      chev.innerHTML = iconSvg('chevron-down', 16) ?? '';
      title.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).closest('a')) return;
        const collapsed = callout.classList.toggle('is-collapsed');
        chev.classList.toggle('is-collapsed', collapsed);
      });
      if (fold === '-') content.style.display = '';
    }
    if (after.trim()) {
      const p = document.createElement('p');
      p.innerHTML = after;
      content.appendChild(p);
    }
    first.remove();
    while (bq.firstChild) content.appendChild(bq.firstChild);
    bq.replaceWith(callout);
  }
}

async function renderMath(root: HTMLElement): Promise<void> {
  const nodes = root.querySelectorAll<HTMLElement>('.math[data-tex]');
  if (nodes.length === 0) return;
  const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
  nodes.forEach((n) => {
    try {
      katex.render(n.dataset.tex ?? '', n, {
        displayMode: n.classList.contains('math-block'),
        throwOnError: false,
      });
    } catch {
      /* leave the TeX source visible */
    }
  });
}

let mermaidSeq = 0;
async function renderMermaid(el: HTMLElement, source: string): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  const dark = document.body.classList.contains('theme-dark');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  try {
    const { svg } = await mermaid.render(`oc-mermaid-${++mermaidSeq}`, source);
    el.innerHTML = svg;
  } catch (err) {
    el.createEl('pre', { cls: 'mermaid-error', text: `Mermaid: ${(err as Error).message}` });
  }
}

/** Width/height from an embed's alt ("300" or "300x200"). */
function applySize(img: HTMLElement, alt: string): void {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alt.trim());
  if (!m) {
    if (alt) img.setAttribute('alt', alt);
    return;
  }
  img.setAttribute('width', m[1]);
  if (m[2]) img.setAttribute('height', m[2]);
}

/** The lines of a note belonging to a heading section or a block id. */
function extractSubpath(text: string, subpath: string, store: VaultStore, file: VFile): string {
  const cache = store.getFileCache(file.path);
  const lines = text.split('\n');
  if (subpath.startsWith('#^')) {
    const id = subpath.slice(2);
    const b = cache?.blocks?.[id];
    if (!b) return text;
    return lines.slice(b.position.start.line, b.position.end.line + 1).join('\n').replace(/\s\^[A-Za-z0-9-]+\s*$/, '');
  }
  const want = subpath.replace(/^#/, '').split('#').pop()!.trim().toLowerCase();
  const hs = cache?.headings ?? [];
  const idx = hs.findIndex((h) => h.heading.trim().toLowerCase() === want);
  if (idx < 0) return text;
  const h = hs[idx];
  const next = hs.slice(idx + 1).find((x) => x.level <= h.level);
  return lines.slice(h.position.start.line, next ? next.position.start.line : lines.length).join('\n');
}

async function renderEmbed(span: HTMLElement, opts: RenderOptions): Promise<void> {
  const store = opts.store;
  const target = span.getAttribute('src') ?? '';
  const alt = span.getAttribute('alt') ?? '';
  const { path: linkpath, subpath } = parseLinktext(target);
  const file = store?.resolveLink(linkpath, opts.sourcePath) ?? null;
  span.empty();
  if (!store || !file) {
    span.addClass('is-unresolved');
    span.createEl('a', {
      cls: 'internal-link is-unresolved',
      text: target,
      attr: { 'data-href': target, href: target },
    });
    return;
  }
  const ext = file.extension;
  try {
    if (IMAGE_EXT.has(ext)) {
      span.addClasses(['image-embed', 'is-loaded']);
      const img = span.createEl('img');
      applySize(img, alt);
      img.src = await store.resourceUrl(file.path);
    } else if (AUDIO_EXT.has(ext)) {
      span.addClasses(['media-embed', 'is-loaded']);
      const a = span.createEl('audio', { attr: { controls: '' } });
      a.src = await store.resourceUrl(file.path);
    } else if (VIDEO_EXT.has(ext)) {
      span.addClasses(['media-embed', 'is-loaded']);
      const v = span.createEl('video', { attr: { controls: '' } });
      v.src = await store.resourceUrl(file.path);
    } else if (ext === 'pdf') {
      span.addClasses(['pdf-embed', 'is-loaded']);
      const frame = span.createEl('iframe', { cls: 'oc-pdf-embed' });
      frame.src = `${await store.resourceUrl(file.path)}${subpath.replace(/^#/, '#') || ''}`;
    } else if (ext === 'md') {
      span.addClasses(['markdown-embed', 'inline-embed', 'is-loaded']);
      const depth = (opts.depth ?? 0) + 1;
      const title = span.createDiv({ cls: 'markdown-embed-title' });
      title.setText(file.basename + (subpath ? ` › ${subpath.replace(/^#\^?/, '')}` : ''));
      const link = span.createDiv({ cls: 'markdown-embed-link' });
      link.innerHTML = iconSvg('link', 14) ?? '';
      link.addEventListener('click', () => (opts.onOpenLink ?? defaultLinkHandler)?.(target, opts.sourcePath, false));
      const content = span.createDiv({ cls: 'markdown-embed-content' });
      if (depth > MAX_EMBED_DEPTH) {
        content.setText('…');
        return;
      }
      let text = await store.read(file.path);
      if (subpath) text = extractSubpath(text, subpath, store, file);
      else text = splitFrontmatter(text).body;
      const preview = content.createDiv({ cls: 'markdown-preview-view markdown-rendered' });
      await renderMarkdown(text, preview, { ...opts, sourcePath: file.path, depth, showProperties: false });
    } else {
      span.addClass('file-embed');
      const a = span.createEl('a', {
        cls: 'internal-link',
        text: file.name,
        attr: { 'data-href': file.path, href: file.path },
      });
      void a;
    }
  } catch (err) {
    span.addClass('is-unresolved');
    span.setText(`${target}: ${(err as Error).message}`);
  }
}

function wireLinks(root: HTMLElement, opts: RenderOptions): void {
  root.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach((a) => {
    const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
    const { path } = parseLinktext(href);
    if (path && opts.store && !opts.store.resolveLink(path, opts.sourcePath)) a.addClass('is-unresolved');
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      (opts.onOpenLink ?? defaultLinkHandler)?.(href, opts.sourcePath, ev.metaKey || ev.ctrlKey);
    });
  });
  root.querySelectorAll<HTMLAnchorElement>('a.tag').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      window.dispatchEvent(new CustomEvent('oc:search', { detail: `tag:${a.textContent ?? ''}` }));
    });
  });
}

/**
 * Render `markdown` into `el` (appends). Sections are rendered one top-level
 * block at a time, each in its own div — exactly the unit Obsidian hands to
 * post-processors (with getSectionInfo line ranges).
 */
export async function renderMarkdown(markdown: string, el: HTMLElement, opts: RenderOptions): Promise<void> {
  const { yaml, body, bodyLineOffset } = splitFrontmatter(markdown);
  let frontmatter: Record<string, unknown> | null = null;
  if (yaml !== null) {
    try {
      const fm = parseYaml(yaml);
      if (fm && typeof fm === 'object' && !Array.isArray(fm)) frontmatter = fm as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    if (opts.showProperties) renderProperties(yaml, el);
  }
  const fileForCtx = opts.store?.getFile(opts.sourcePath) ?? null;
  const sections = new Map<HTMLElement, SectionInfo>();
  const ctx: PostProcessorContext = {
    docId: fileForCtx?.node.docId ?? '',
    sourcePath: opts.sourcePath,
    frontmatter,
    addChild: (child) => {
      if (opts.addChild) opts.addChild(child);
      else if (child.load) child.load();
      else child.onload?.();
    },
    getSectionInfo: (target) => {
      let cur: HTMLElement | null = target;
      while (cur && !sections.has(cur)) cur = cur.parentElement;
      return cur ? sections.get(cur)! : null;
    },
  };

  const tokens = obsidianMarked.lexer(body) as TokensList;
  const lines = markdown.split('\n');
  let line = bodyLineOffset;
  const sectionEls: HTMLElement[] = [];
  for (const tok of tokens as Token[]) {
    const nl = (tok.raw.match(/\n/g) ?? []).length;
    const startLine = line;
    line += nl;
    if (tok.type === 'space') continue;
    const endLine = Math.max(startLine, line - (tok.raw.endsWith('\n') ? 1 : 0));
    const list = [tok] as unknown as TokensList;
    list.links = tokens.links;
    const html = obsidianMarked.parser(list);
    const div = el.createDiv();
    div.innerHTML = sanitize(html);
    if (!div.hasChildNodes()) {
      div.remove();
      continue;
    }
    sections.set(div, { text: markdown, lineStart: startLine, lineEnd: endLine });
    // Task checkboxes: map each to its source line for toggling.
    if (opts.onToggleTask) {
      let ln = startLine;
      div.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((cb) => {
        while (ln <= endLine && !/^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[.\]/.test(lines[ln] ?? '')) ln++;
        const target = ln++;
        cb.addEventListener('click', (ev) => {
          ev.preventDefault();
          opts.onToggleTask?.(target, !cb.checked);
        });
      });
    } else {
      div.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((cb) => (cb.disabled = true));
    }
    sectionEls.push(div);
  }

  for (const div of sectionEls) {
    buildCallouts(div);
    div.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((h) => {
      h.setAttribute('data-heading', h.textContent ?? '');
      h.id = (h.textContent ?? '').trim().replace(/\s+/g, '-');
    });
    wireLinks(div, opts);
    div.querySelectorAll('table').forEach((t) => {
      if (!t.parentElement?.classList.contains('table-wrapper')) {
        const w = document.createElement('div');
        w.className = 'table-wrapper';
        t.replaceWith(w);
        w.appendChild(t);
      }
    });
  }

  // Async parts: embeds, math, code blocks, plugin post-processors.
  const jobs: Promise<unknown>[] = [];
  for (const div of sectionEls) {
    div.querySelectorAll<HTMLElement>('span.internal-embed').forEach((span) => jobs.push(renderEmbed(span, opts)));
    jobs.push(renderMath(div));
    div.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
      const lang = /language-([^\s]+)/.exec(code.className)?.[1];
      if (!lang) return;
      const pre = code.parentElement!;
      const source = code.textContent ?? '';
      const processor = markdownHooks.codeBlockProcessors.get(lang);
      if (lang === 'mermaid' && !processor) {
        const box = document.createElement('div');
        box.className = 'block-language-mermaid mermaid';
        pre.replaceWith(box);
        jobs.push(renderMermaid(box, source));
        return;
      }
      if (!processor) return;
      const box = document.createElement('div');
      box.className = `block-language-${lang}`;
      pre.replaceWith(box);
      jobs.push(
        Promise.resolve()
          .then(() => processor(source.replace(/\n$/, ''), box, ctx))
          .catch((err) => box.createEl('pre', { cls: 'oc-plugin-error', text: `${lang}: ${(err as Error).message}` })),
      );
    });
  }
  const post = [...markdownHooks.postProcessors].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const div of sectionEls) {
    for (const p of post) {
      jobs.push(
        Promise.resolve()
          .then(() => p.fn(div, ctx))
          .catch((err) => console.error('post-processor failed', err)),
      );
    }
  }
  await Promise.all(jobs);
}
