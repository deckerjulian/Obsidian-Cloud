import { EditorState, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { renderMarkdown } from '../markdown/render';
import { setIcon } from '../markdown/icons';
import type { VaultStore } from '../vault/VaultStore';

/**
 * Obsidian's Live Preview for the CodeMirror editor: the note is edited as
 * Markdown source, but everything the cursor is not in is shown rendered —
 * markers (`#`, `**`, `[[`, …) hidden, links clickable, bullets and task
 * checkboxes drawn, and whole blocks (tables, callouts, code incl. plugin
 * blocks like Dataview, math, front matter) replaced by their reading-view
 * rendering. Moving the cursor into an element reveals its source.
 */

export interface LivePreviewConfig {
  store: VaultStore;
  sourcePath: string;
  onOpenLink: (linktext: string, sourcePath: string, newLeaf: boolean) => void;
}

interface Child {
  load?(): void;
  unload?(): void;
  onload?(): void;
}

// ── block structure ─────────────────────────────────────────────────────────

export type BlockKind = 'frontmatter' | 'code' | 'math' | 'table' | 'callout';
export interface Block {
  kind: BlockKind;
  from: number;
  to: number;
  /** 1-based first line. */
  line: number;
}

const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Find the rendered-as-a-whole blocks of a note (line-based, like Obsidian). */
export function scanBlocks(doc: Text): Block[] {
  const out: Block[] = [];
  const n = doc.lines;
  const push = (kind: BlockKind, a: number, b: number): void => {
    out.push({ kind, from: doc.line(a).from, to: doc.line(b).to, line: a });
  };
  let i = 1;
  if (n >= 2 && doc.line(1).text.trimEnd() === '---') {
    for (let j = 2; j <= n; j++) {
      const tx = doc.line(j).text.trimEnd();
      if (tx === '---' || tx === '...') {
        push('frontmatter', 1, j);
        i = j + 1;
        break;
      }
    }
  }
  while (i <= n) {
    const tx = doc.line(i).text;
    const fence = /^\s*(`{3,}|~{3,})/.exec(tx);
    if (fence) {
      const f = fence[1];
      const close = new RegExp(`^\\s*${f[0] === '`' ? '`' : '~'}{${f.length},}\\s*$`);
      let j = i + 1;
      while (j <= n && !close.test(doc.line(j).text)) j++;
      const end = Math.min(j, n);
      push('code', i, end);
      i = end + 1;
      continue;
    }
    if (/^\s*\$\$/.test(tx)) {
      const t = tx.trim();
      if (t.length > 4 && t.endsWith('$$')) {
        push('math', i, i);
        i++;
        continue;
      }
      let j = i + 1;
      while (j <= n && !/\$\$\s*$/.test(doc.line(j).text)) j++;
      if (j <= n) {
        push('math', i, j);
        i = j + 1;
        continue;
      }
    }
    if (/^\s*>\s*\[![^\]]+\]/.test(tx)) {
      let j = i;
      while (j + 1 <= n && /^\s*>/.test(doc.line(j + 1).text)) j++;
      push('callout', i, j);
      i = j + 1;
      continue;
    }
    if (tx.includes('|') && i + 1 <= n && TABLE_DELIM.test(doc.line(i + 1).text) && doc.line(i + 1).text.includes('-')) {
      let j = i + 1;
      while (j + 1 <= n && doc.line(j + 1).text.includes('|') && doc.line(j + 1).text.trim()) j++;
      push('table', i, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Remove the indentation all lines share (blocks nested in lists). */
function dedent(text: string): string {
  const lines = text.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return ind > 0 && Number.isFinite(ind) ? lines.map((l) => l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length))).join('\n') : text;
}

/** Toggle the task checkbox on a 1-based line. */
function toggleTaskLine(view: EditorView, lineNo: number): void {
  if (view.state.readOnly || lineNo < 1 || lineNo > view.state.doc.lines) return;
  const line = view.state.doc.line(lineNo);
  const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)\]/.exec(line.text);
  if (!m) return;
  const at = line.from + m[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
}

/** Put the cursor at `pos` (reveals the source there). */
function revealAt(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

const INTERACTIVE = 'a, input, button, select, textarea, label, video, audio, .internal-link, .external-link, .tag, .clickable-icon';

class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly kind: BlockKind,
    readonly text: string,
    readonly cfg: LivePreviewConfig,
  ) {
    super();
  }
  override eq(other: RenderedBlockWidget): boolean {
    return other.kind === this.kind && other.text === this.text && other.cfg === this.cfg;
  }
  override get estimatedHeight(): number {
    return Math.max(1, this.text.split('\n').length) * 26;
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `cm-embed-block markdown-rendered oc-lp-block oc-lp-${this.kind}`;
    const inner = document.createElement('div');
    inner.className = 'oc-lp-block-content';
    wrap.appendChild(inner);
    const children: Child[] = [];
    (wrap as unknown as { ocChildren: Child[] }).ocChildren = children;
    const startLine = (): number => view.state.doc.lineAt(view.posAtDOM(wrap)).number;
    void renderMarkdown(this.kind === 'frontmatter' ? this.text : dedent(this.text), inner, {
      store: this.cfg.store,
      sourcePath: this.cfg.sourcePath,
      showProperties: this.kind === 'frontmatter',
      onOpenLink: this.cfg.onOpenLink,
      onToggleTask: (line) => toggleTaskLine(view, startLine() + line),
      addChild: (c) => {
        children.push(c);
        if (c.load) c.load();
        else c.onload?.();
      },
    })
      .catch((e) => inner.replaceChildren(Object.assign(document.createElement('pre'), { textContent: String(e) })))
      .finally(() => view.requestMeasure());

    const edit = document.createElement('div');
    edit.className = 'edit-block-button clickable-icon';
    edit.title = 'Quelltext bearbeiten';
    setIcon(edit, 'code-2');
    wrap.appendChild(edit);
    wrap.addEventListener('mousedown', (ev) => {
      const target = ev.target as HTMLElement;
      if (ev.button !== 0 || (target !== edit && !edit.contains(target) && target.closest(INTERACTIVE))) return;
      if (view.state.readOnly && target !== edit && !edit.contains(target)) return;
      ev.preventDefault();
      revealAt(view, view.posAtDOM(wrap));
    });
    return wrap;
  }
  override destroy(dom: HTMLElement): void {
    for (const c of (dom as unknown as { ocChildren?: Child[] }).ocChildren ?? []) {
      try {
        c.unload?.();
      } catch (e) {
        console.error(e);
      }
    }
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const setFocus = StateEffect.define<boolean>();

interface BlockState {
  blocks: Block[];
  focused: boolean;
  deco: DecorationSet;
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function blockField(cfg: LivePreviewConfig): StateField<BlockState> {
  const build = (state: EditorState, blocks: Block[], focused: boolean): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    for (const b of blocks) {
      if (focused && selectionTouches(state, b.from, b.to)) {
        if (b.kind === 'code') {
          for (let l = state.doc.lineAt(b.from).number; l <= state.doc.lineAt(b.to).number; l++)
            ranges.push(Decoration.line({ class: 'HyperMD-codeblock oc-lp-code-source' }).range(state.doc.line(l).from));
        }
        continue;
      }
      ranges.push(
        Decoration.replace({
          widget: new RenderedBlockWidget(b.kind, state.doc.sliceString(b.from, b.to), cfg),
          block: true,
        }).range(b.from, b.to),
      );
    }
    return Decoration.set(ranges, true);
  };
  return StateField.define<BlockState>({
    create(state) {
      const blocks = scanBlocks(state.doc);
      return { blocks, focused: false, deco: build(state, blocks, false) };
    },
    update(value, tr) {
      let { blocks, focused } = value;
      for (const e of tr.effects) if (e.is(setFocus)) focused = e.value;
      if (tr.docChanged) blocks = scanBlocks(tr.state.doc);
      if (!tr.docChanged && !tr.selection && focused === value.focused) return value;
      return { blocks, focused, deco: build(tr.state, blocks, focused) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });
}

// ── inline elements ─────────────────────────────────────────────────────────

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'list-bullet';
    s.textContent = '•';
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(o: CheckboxWidget): boolean {
    return o.checked === this.checked;
  }
  override toDOM(view: EditorView): HTMLElement {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'task-list-item-checkbox';
    cb.checked = this.checked;
    cb.addEventListener('mousedown', (e) => e.preventDefault());
    cb.addEventListener('click', (e) => {
      e.preventDefault();
      toggleTaskLine(view, view.state.doc.lineAt(view.posAtDOM(cb)).number);
    });
    return cb;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class LinkSeparatorWidget extends WidgetType {
  constructor(
    readonly href: string,
    readonly cls: string,
  ) {
    super();
  }
  override eq(o: LinkSeparatorWidget): boolean {
    return o.href === this.href && o.cls === this.cls;
  }
  override toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = this.cls;
    s.dataset.href = this.href;
    s.textContent = ' > ';
    return s;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const hr = document.createElement('hr');
    hr.className = 'oc-lp-hr';
    return hr;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  override eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = `math ${this.display ? 'math-block' : 'math-inline'} oc-lp-math`;
    el.textContent = this.tex;
    void Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([{ default: katex }]) => {
      try {
        katex.render(this.tex, el, { displayMode: this.display, throwOnError: false });
      } catch {
        /* keep the source */
      }
    });
    return el;
  }
}

/** `![[…]]` and `![](…)`: rendered by the reading-view renderer. */
class EmbedWidget extends WidgetType {
  constructor(
    readonly markdown: string,
    readonly block: boolean,
    readonly cfg: LivePreviewConfig,
  ) {
    super();
  }
  override eq(o: EmbedWidget): boolean {
    return o.markdown === this.markdown && o.block === this.block && o.cfg === this.cfg;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = `oc-lp-embed markdown-rendered${this.block ? ' is-block' : ''}`;
    const children: Child[] = [];
    (el as unknown as { ocChildren: Child[] }).ocChildren = children;
    void renderMarkdown(this.markdown, el, {
      store: this.cfg.store,
      sourcePath: this.cfg.sourcePath,
      onOpenLink: this.cfg.onOpenLink,
      addChild: (c) => {
        children.push(c);
        if (c.load) c.load();
        else c.onload?.();
      },
    }).finally(() => view.requestMeasure());
    return el;
  }
  override destroy(dom: HTMLElement): void {
    for (const c of (dom as unknown as { ocChildren?: Child[] }).ocChildren ?? []) c.unload?.();
  }
  override ignoreEvent(e: Event): boolean {
    // Clicks on links/controls inside the embed stay with the embed; any
    // other click moves the cursor there (revealing the source).
    return !!(e.target as HTMLElement).closest?.(INTERACTIVE);
  }
}

function inlinePlugin(cfg: LivePreviewConfig, field: StateField<BlockState>) {
  const build = (view: EditorView): DecorationSet => {
    const { state } = view;
    const doc = state.doc;
    const { blocks, focused } = state.field(field);
    const out: Range<Decoration>[] = [];
    const inBlock = (pos: number): boolean => {
      let lo = 0;
      let hi = blocks.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const b = blocks[mid];
        if (pos < b.from) hi = mid - 1;
        else if (pos > b.to) lo = mid + 1;
        else return true;
      }
      return false;
    };
    const touches = (from: number, to: number): boolean => focused && selectionTouches(state, from, to);
    const lineActive = (pos: number): boolean => {
      const l = doc.lineAt(pos);
      return touches(l.from, l.to);
    };
    const hide = (from: number, to: number): void => {
      if (to > from) out.push(Decoration.replace({}).range(from, to));
    };
    const replace = (from: number, to: number, widget: WidgetType): void => {
      out.push(Decoration.replace({ widget }).range(from, to));
    };
    const mark = (from: number, to: number, cls: string, attributes?: Record<string, string>): void => {
      if (to > from) out.push(Decoration.mark({ class: cls, attributes }).range(from, to));
    };
    const lineClass = (pos: number, cls: string, attributes?: Record<string, string>): void => {
      out.push(Decoration.line({ class: cls, attributes }).range(doc.lineAt(pos).from));
    };
    const text = (n: { from: number; to: number } | null | undefined): string => (n ? doc.sliceString(n.from, n.to) : '');
    const onlyOnLine = (from: number, to: number): boolean => {
      const l = doc.lineAt(from);
      return doc.sliceString(l.from, from).trim() === '' && doc.sliceString(to, l.to).trim() === '';
    };

    for (const { from, to } of view.visibleRanges) {
      syntaxTree(state).iterate({
        from,
        to,
        enter: (ref) => {
          const name = ref.name;
          if (name === 'Document') return;
          if (inBlock(ref.from)) return false;
          if (name === 'FencedCode' || name === 'CodeBlock' || name === 'HTMLBlock' || name === 'CommentBlock') return false;
          const node: SyntaxNode = ref.node;
          switch (name) {
            case 'HeaderMark': {
              if (node.parent?.name.startsWith('SetextHeading') || lineActive(ref.from)) return;
              const l = doc.lineAt(ref.from);
              if (doc.sliceString(l.from, ref.from).trim() === '') {
                hide(ref.from, Math.min(l.to, ref.to + (doc.sliceString(ref.to, ref.to + 1) === ' ' ? 1 : 0)));
              } else {
                // Closing `#`s of `## Title ##`.
                let s = ref.from;
                while (s > l.from && doc.sliceString(s - 1, s) === ' ') s--;
                hide(s, ref.to);
              }
              return;
            }
            case 'EmphasisMark':
            case 'StrikethroughMark':
            case 'HighlightMark': {
              const p = node.parent;
              if (p && !touches(p.from, p.to)) hide(ref.from, ref.to);
              return;
            }
            case 'InlineCode': {
              mark(ref.from, ref.to, 'cm-inline-code');
              if (!touches(ref.from, ref.to)) {
                for (const m of node.getChildren('CodeMark')) hide(m.from, m.to);
              }
              return false;
            }
            case 'Escape':
              if (!touches(ref.from, ref.to)) hide(ref.from, ref.from + 1);
              return;
            case 'Link': {
              if (touches(ref.from, ref.to)) return;
              const marks = node.getChildren('LinkMark');
              const url = node.getChild('URL');
              if (marks.length < 2 || !url) return;
              const textFrom = marks[0].to;
              const textTo = marks[1].from;
              hide(ref.from, textFrom);
              hide(textTo, ref.to);
              mark(textFrom, textTo, 'cm-link oc-lp-link', { 'data-href': text(url) });
              return;
            }
            case 'URL': {
              const p = node.parent?.name;
              if (p === 'Link' || p === 'Image' || p === 'LinkReference') return;
              mark(ref.from, ref.to, 'cm-url oc-lp-link', { 'data-href': text(node) });
              return;
            }
            case 'Image': {
              if (touches(ref.from, ref.to)) return false;
              replace(ref.from, ref.to, new EmbedWidget(text(node), onlyOnLine(ref.from, ref.to), cfg));
              return false;
            }
            case 'WikiLink': {
              if (touches(ref.from, ref.to)) return false;
              const target = node.getChild('WikiTarget');
              const alias = node.getChild('WikiAlias');
              const shown = alias ?? target;
              if (!shown) return false;
              const link = text(target);
              const path = link.split('#')[0].split('^')[0];
              const resolved = !path || !!cfg.store.resolveLink(path, cfg.sourcePath);
              const cls = `cm-hmd-internal-link oc-lp-internal-link${resolved ? '' : ' is-unresolved'}`;
              hide(ref.from, shown.from);
              hide(shown.to, ref.to);
              // `[[Note#Heading]]` reads "Note > Heading", as in Obsidian.
              const sep = alias ? -1 : link.search(/#\^?/);
              if (sep > 0) {
                const at = shown.from + sep;
                const len = link[sep + 1] === '^' ? 2 : 1;
                mark(shown.from, at, cls, { 'data-href': link });
                replace(at, at + len, new LinkSeparatorWidget(link, cls));
                mark(at + len, shown.to, cls, { 'data-href': link });
              } else mark(shown.from, shown.to, cls, { 'data-href': link });
              return false;
            }
            case 'WikiEmbed': {
              if (touches(ref.from, ref.to)) return false;
              replace(ref.from, ref.to, new EmbedWidget(text(node), onlyOnLine(ref.from, ref.to), cfg));
              return false;
            }
            case 'InlineMath': {
              if (touches(ref.from, ref.to)) return false;
              const display = text(node).startsWith('$$');
              const m = display ? 2 : 1;
              replace(ref.from, ref.to, new MathWidget(doc.sliceString(ref.from + m, ref.to - m), display));
              return false;
            }
            case 'Hashtag':
              mark(ref.from, ref.to, 'cm-hashtag oc-lp-tag', { 'data-tag': text(node) });
              return false;
            case 'ListMark': {
              const item = node.parent;
              const bullet = item?.parent?.name === 'BulletList';
              const task = item?.getChild('Task');
              const tm = task?.getChild('TaskMarker');
              lineClass(ref.from, 'HyperMD-list-line');
              if (tm) {
                const ch = doc.sliceString(tm.from + 1, tm.from + 2);
                lineClass(ref.from, `HyperMD-task-line${ch !== ' ' ? ' is-checked' : ''}`, { 'data-task': ch });
                if (!touches(ref.from, tm.to)) replace(bullet ? ref.from : tm.from, tm.to, new CheckboxWidget(ch !== ' '));
              } else if (bullet && !touches(ref.from, ref.to)) {
                replace(ref.from, ref.to, new BulletWidget());
              }
              return;
            }
            case 'QuoteMark': {
              lineClass(ref.from, 'HyperMD-quote oc-lp-quote');
              if (!lineActive(ref.from)) hide(ref.from, ref.to + (doc.sliceString(ref.to, ref.to + 1) === ' ' ? 1 : 0));
              return;
            }
            case 'HorizontalRule':
              if (!lineActive(ref.from)) replace(ref.from, ref.to, new HrWidget());
              return false;
          }
          return;
        },
      });
    }
    return Decoration.set(out, true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate): void {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.startState.field(field).focused !== u.state.field(field).focused
        )
          this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Live Preview editor extension for one note. */
export function livePreview(cfg: LivePreviewConfig): Extension {
  const field = blockField(cfg);
  return [
    field,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    inlinePlugin(cfg, field),
    EditorView.editorAttributes.of({ class: 'is-live-preview' }),
    EditorView.domEventHandlers({
      mousedown(e) {
        if (e.button !== 0) return false;
        const t = e.target as HTMLElement;
        const internal = t.closest<HTMLElement>('.oc-lp-internal-link');
        if (internal?.dataset.href !== undefined) {
          e.preventDefault();
          cfg.onOpenLink(internal.dataset.href, cfg.sourcePath, e.metaKey || e.ctrlKey);
          return true;
        }
        const ext = t.closest<HTMLElement>('.oc-lp-link');
        if (ext?.dataset.href) {
          e.preventDefault();
          const href = ext.dataset.href;
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) window.open(href, '_blank', 'noopener');
          else cfg.onOpenLink(decodeURI(href), cfg.sourcePath, e.metaKey || e.ctrlKey);
          return true;
        }
        const tag = t.closest<HTMLElement>('.oc-lp-tag');
        if (tag?.dataset.tag && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('oc:search', { detail: `tag:${tag.dataset.tag}` }));
          return true;
        }
        return false;
      },
    }),
  ];
}
