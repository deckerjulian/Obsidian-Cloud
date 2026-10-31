import { StateField, EditorSelection, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Component, Events, Scope } from './component';
import { TFile, type TAbstractFile } from './files';
import { setIcon } from './util';
import type { App } from './app';
import type { EditorPosition } from './ui';
import type { WorkspaceHost, ViewMode } from '../host';

/**
 * Workspace, leaves, views and the Editor API. The web app has a single main
 * pane; leaves are thin handles onto it (opening a file in a leaf opens it in
 * the workspace host), plus one leaf per mounted plugin view.
 */

// ── Editor (Obsidian's CM-independent editor API) ───────────────────────────
interface EditorBackend {
  text(): string;
  /** Replace [from, to) with `insert`; optionally set the selection afterwards. */
  change(from: number, to: number, insert: string, selection?: { anchor: number; head: number }): void;
  selection(): { anchor: number; head: number };
  setSelection(anchor: number, head: number): void;
  focus(): void;
  cm: EditorView | null;
}

function cmBackend(view: EditorView): EditorBackend {
  return {
    cm: view,
    text: () => view.state.doc.toString(),
    change(from, to, insert, selection) {
      view.dispatch({
        changes: { from, to, insert },
        ...(selection ? { selection: EditorSelection.single(selection.anchor, selection.head) } : {}),
        userEvent: 'input.plugin',
      });
    },
    selection: () => {
      const s = view.state.selection.main;
      return { anchor: s.anchor, head: s.head };
    },
    setSelection(anchor, head) {
      view.dispatch({ selection: EditorSelection.single(anchor, head), scrollIntoView: true });
    },
    focus: () => view.focus(),
  };
}

/** An editor over a note that has no live CodeMirror view (reading mode). */
function textBackend(host: WorkspaceHost, path: string): EditorBackend {
  let doc = host.store.cachedText(path) ?? '';
  let sel = { anchor: 0, head: 0 };
  let pending: Promise<void> = Promise.resolve();
  return {
    cm: null,
    text: () => doc,
    change(from, to, insert, selection) {
      doc = doc.slice(0, from) + insert + doc.slice(to);
      if (selection) sel = selection;
      const snapshot = doc;
      pending = pending.then(() => host.store.write(path, snapshot)).catch((e) => console.error(e));
    },
    selection: () => sel,
    setSelection(anchor, head) {
      sel = { anchor, head };
    },
    focus: () => undefined,
  };
}

export class Editor {
  constructor(private readonly b: EditorBackend) {}
  get cm(): EditorView | null {
    return this.b.cm;
  }
  private lines(): string[] {
    return this.b.text().split('\n');
  }
  posToOffset(pos: EditorPosition): number {
    const lines = this.lines();
    let off = 0;
    const line = Math.max(0, Math.min(pos.line, lines.length - 1));
    for (let i = 0; i < line; i++) off += lines[i].length + 1;
    return off + Math.max(0, Math.min(pos.ch, lines[line].length));
  }
  offsetToPos(offset: number): EditorPosition {
    const lines = this.lines();
    let off = Math.max(0, offset);
    for (let line = 0; line < lines.length; line++) {
      if (off <= lines[line].length) return { line, ch: off };
      off -= lines[line].length + 1;
    }
    const last = lines.length - 1;
    return { line: last, ch: lines[last].length };
  }
  getDoc(): this {
    return this;
  }
  refresh(): void {}
  getValue(): string {
    return this.b.text();
  }
  setValue(content: string): void {
    this.b.change(0, this.b.text().length, content);
  }
  getLine(line: number): string {
    return this.lines()[line] ?? '';
  }
  setLine(n: number, text: string): void {
    const from = this.posToOffset({ line: n, ch: 0 });
    this.b.change(from, from + this.getLine(n).length, text);
  }
  lineCount(): number {
    return this.lines().length;
  }
  lastLine(): number {
    return this.lineCount() - 1;
  }
  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.b.text().slice(this.posToOffset(from), this.posToOffset(to));
  }
  getSelection(): string {
    const s = this.b.selection();
    return this.b.text().slice(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head));
  }
  somethingSelected(): boolean {
    const s = this.b.selection();
    return s.anchor !== s.head;
  }
  getCursor(which: 'from' | 'to' | 'head' | 'anchor' = 'head'): EditorPosition {
    const s = this.b.selection();
    const v =
      which === 'from' ? Math.min(s.anchor, s.head) : which === 'to' ? Math.max(s.anchor, s.head) : which === 'anchor' ? s.anchor : s.head;
    return this.offsetToPos(v);
  }
  listSelections(): Array<{ anchor: EditorPosition; head: EditorPosition }> {
    const s = this.b.selection();
    return [{ anchor: this.offsetToPos(s.anchor), head: this.offsetToPos(s.head) }];
  }
  setCursor(pos: EditorPosition | number, ch?: number): void {
    const p = typeof pos === 'number' ? { line: pos, ch: ch ?? 0 } : pos;
    const o = this.posToOffset(p);
    this.b.setSelection(o, o);
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    this.b.setSelection(this.posToOffset(anchor), this.posToOffset(head ?? anchor));
  }
  setSelections(ranges: Array<{ anchor: EditorPosition; head?: EditorPosition }>, _main?: number): void {
    if (ranges[0]) this.setSelection(ranges[0].anchor, ranges[0].head);
  }
  replaceSelection(replacement: string): void {
    const s = this.b.selection();
    const from = Math.min(s.anchor, s.head);
    const to = Math.max(s.anchor, s.head);
    const end = from + replacement.length;
    this.b.change(from, to, replacement, { anchor: end, head: end });
  }
  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, _origin?: string): void {
    const a = this.posToOffset(from);
    const b = to ? this.posToOffset(to) : a;
    this.b.change(a, b, replacement);
  }
  transaction(tx: {
    changes?: Array<{ from: EditorPosition; to?: EditorPosition; text: string }>;
    selection?: { from: EditorPosition; to?: EditorPosition };
    replaceSelection?: string;
  }): void {
    if (tx.replaceSelection !== undefined) this.replaceSelection(tx.replaceSelection);
    const changes = [...(tx.changes ?? [])].sort((x, y) => this.posToOffset(y.from) - this.posToOffset(x.from));
    for (const c of changes) this.replaceRange(c.text, c.from, c.to);
    if (tx.selection) this.setSelection(tx.selection.from, tx.selection.to);
  }
  processLines<T>(read: (line: number, lineText: string) => T | null, write: (line: number, lineText: string, value: T | null) => { from: EditorPosition; to?: EditorPosition; text: string } | void, _ignoreEmpty = true): void {
    const changes: Array<{ from: EditorPosition; to?: EditorPosition; text: string }> = [];
    for (let i = 0; i < this.lineCount(); i++) {
      const v = read(i, this.getLine(i));
      const c = write(i, this.getLine(i), v);
      if (c) changes.push(c);
    }
    this.transaction({ changes });
  }
  wordAt(pos: EditorPosition): { from: EditorPosition; to: EditorPosition } | null {
    const line = this.getLine(pos.line);
    let s = pos.ch;
    let e = pos.ch;
    while (s > 0 && /\w/.test(line[s - 1])) s--;
    while (e < line.length && /\w/.test(line[e])) e++;
    return s === e ? null : { from: { line: pos.line, ch: s }, to: { line: pos.line, ch: e } };
  }
  focus(): void {
    this.b.focus();
  }
  blur(): void {
    (this.b.cm?.contentDOM as HTMLElement | undefined)?.blur();
  }
  hasFocus(): boolean {
    return this.b.cm?.hasFocus ?? false;
  }
  getScrollInfo(): { top: number; left: number } {
    const s = this.b.cm?.scrollDOM;
    return { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 };
  }
  scrollTo(x?: number | null, y?: number | null): void {
    const s = this.b.cm?.scrollDOM;
    if (!s) return;
    if (x !== null && x !== undefined) s.scrollLeft = x;
    if (y !== null && y !== undefined) s.scrollTop = y;
  }
  scrollIntoView(_range: unknown, _center?: boolean): void {}
  undo(): void {}
  redo(): void {}
  exec(command: string): void {
    if (command === 'goStart') this.setCursor({ line: 0, ch: 0 });
    else if (command === 'goEnd') this.setCursor(this.offsetToPos(this.getValue().length));
  }
}

// ── CM6 state fields Obsidian exposes ───────────────────────────────────────
export interface MarkdownFileInfo {
  app: App;
  file: TFile | null;
  editor?: Editor;
}
let infoProvider: (() => MarkdownFileInfo | null) | null = null;
export function setEditorInfoProvider(fn: (() => MarkdownFileInfo | null) | null): void {
  infoProvider = fn;
}
/** `editorInfoField`: the file/app the editor belongs to (read at creation). */
export const editorInfoField = StateField.define<MarkdownFileInfo | null>({
  create: () => infoProvider?.() ?? null,
  update: (v) => v,
});
/** `editorLivePreviewField`: the web editor is a source-mode editor. */
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => false,
  update: (v) => v,
});
export const editorEditorField = StateField.define<EditorView | null>({
  create: () => null,
  update: (v) => v,
});
export const editorViewField = editorInfoField;
export const livePreviewState: Extension = [];

// ── views ───────────────────────────────────────────────────────────────────
export abstract class View extends Component {
  app: App;
  icon = '';
  navigation = false;
  containerEl: HTMLElement;
  scope: Scope | null = null;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.containerEl = createDiv({ cls: 'workspace-leaf-content' });
  }
  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string {
    return this.icon;
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  onResize(): void {}
  onPaneMenu(_menu: unknown, _source: string): void {}
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  headerEl: HTMLElement;
  titleEl: HTMLElement;
  actionsEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Obsidian layout: containerEl.children = [view-header, view-content].
    this.headerEl = this.containerEl.createDiv({ cls: 'view-header' });
    this.titleEl = this.headerEl.createDiv({ cls: 'view-header-title' });
    this.actionsEl = this.headerEl.createDiv({ cls: 'view-actions' });
    this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
  }
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const a = this.actionsEl.createEl('a', { cls: 'view-action clickable-icon', attr: { 'aria-label': title } });
    setIcon(a, icon);
    a.addEventListener('click', callback);
    return a;
  }
}

export abstract class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  override navigation = true;
  getDisplayText(): string {
    return this.file?.basename ?? 'No file';
  }
  override getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }
  override async setState(state: any, _result: unknown): Promise<void> {
    const f = state?.file ? this.app.vault.getAbstractFileByPath(state.file) : null;
    if (f instanceof TFile) {
      if (this.file) await this.onUnloadFile(this.file);
      this.file = f;
      await this.onLoadFile(f);
    }
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(_file: TFile): Promise<void> {}
  canAcceptExtension(_extension: string): boolean {
    return false;
  }
}

export abstract class TextFileView extends FileView {
  data = '';
  requestSave = (): void => {
    void this.save();
  };
  override async onLoadFile(file: TFile): Promise<void> {
    this.data = await this.app.vault.read(file);
    this.setViewData(this.data, true);
  }
  override async onUnloadFile(_file: TFile): Promise<void> {
    await this.save();
  }
  async save(_clear?: boolean): Promise<void> {
    if (!this.file) return;
    const next = this.getViewData();
    if (next !== this.data) {
      this.data = next;
      await this.app.vault.modify(this.file, next);
    }
  }
  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
}

/**
 * The active note as a MarkdownView. Its `editor` targets the live CodeMirror
 * view in source mode, or the note's text (written via the store) otherwise.
 */
export class MarkdownView extends TextFileView {
  previewMode: { rerender: (full?: boolean) => void; containerEl: HTMLElement };
  currentMode: { type: ViewMode };
  private _editor: Editor | null = null;
  private _editorFor: EditorView | string | null = null;
  constructor(
    leaf: WorkspaceLeaf,
    private readonly host?: WorkspaceHost,
  ) {
    super(leaf);
    this.previewMode = { rerender: () => host?.rerenderActive(), containerEl: this.contentEl };
    this.currentMode = { type: 'preview' };
  }
  getViewType(): string {
    return 'markdown';
  }
  getMode(): ViewMode {
    return this.host?.getActiveMode() ?? 'preview';
  }
  get editor(): Editor {
    const view = this.host?.getActiveEditorView() ?? null;
    const key = view ?? this.file?.path ?? '';
    if (!this._editor || this._editorFor !== key) {
      this._editor = new Editor(view ? cmBackend(view) : textBackend(this.host!, this.file?.path ?? ''));
      this._editorFor = key;
    }
    this.currentMode = { type: this.getMode() };
    return this._editor;
  }
  getViewData(): string {
    return this.editor.getValue();
  }
  setViewData(data: string, _clear: boolean): void {
    if (this.editor.getValue() !== data) this.editor.setValue(data);
  }
  clear(): void {}
  override async onLoadFile(_file: TFile): Promise<void> {}
  override async save(): Promise<void> {}
  showSearch(_replace?: boolean): void {}
}

/** Placeholder for leaves without a view (and the shim's "empty" view). */
class EmptyView extends ItemView {
  getViewType(): string {
    return 'empty';
  }
  getDisplayText(): string {
    return 'New tab';
  }
}

// ── leaves ──────────────────────────────────────────────────────────────────
export class WorkspaceLeaf extends Events {
  view: View;
  parent: unknown = null;
  pinned = false;
  working = false;
  /** Set for leaves mounted by the UI (plugin views). */
  detachFn: (() => void) | null = null;
  constructor(
    public app: App,
    private readonly host?: WorkspaceHost,
  ) {
    super();
    this.view = new EmptyView(this);
  }
  get containerEl(): HTMLElement {
    return this.view.containerEl;
  }
  async openFile(file: TFile, openState?: { state?: { mode?: ViewMode }; eState?: { subpath?: string } }): Promise<void> {
    this.host?.openFile(file.path, { mode: openState?.state?.mode, subpath: openState?.eState?.subpath });
  }
  async open(view: View): Promise<View> {
    this.view = view;
    return view;
  }
  getViewState(): { type: string; state: Record<string, unknown> } {
    return { type: this.view.getViewType(), state: this.view.getState() };
  }
  async setViewState(viewState: { type: string; state?: any; active?: boolean }, _eState?: unknown): Promise<void> {
    const { type, state } = viewState;
    if (type === 'markdown' || type === 'empty') {
      if (state?.file) this.host?.openFile(state.file, { mode: state.mode });
      return;
    }
    this.host?.openView(type, state ?? {});
  }
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}
  togglePinned(): void {
    this.pinned = !this.pinned;
  }
  setPinned(pinned: boolean): void {
    this.pinned = pinned;
  }
  setGroupMember(_other: WorkspaceLeaf): void {}
  setGroup(_group: string): void {}
  getDisplayText(): string {
    return this.view.getDisplayText();
  }
  getIcon(): string {
    return this.view.getIcon();
  }
  detach(): void {
    this.detachFn?.();
  }
  async loadIfDeferred(): Promise<void> {}
  isDeferred = false;
  rebuildView(): void {
    this.host?.rerenderActive();
  }
}

// ── workspace ───────────────────────────────────────────────────────────────
export class Workspace extends Events {
  layoutReady = false;
  containerEl: HTMLElement = createDiv({ cls: 'workspace' });
  rootSplit = { children: [] as unknown[] };
  leftSplit = { collapsed: true, expand() {}, collapse() {}, toggle() {} };
  rightSplit = { collapsed: true, expand() {}, collapse() {}, toggle() {} };
  leftRibbon = {};
  requestSaveLayout = (): void => undefined;
  private readyCbs: Array<() => unknown> = [];
  private readonly mainLeaf: WorkspaceLeaf;
  private readonly mdView: MarkdownView;
  /** Mounted plugin views (by the UI via RegisteredView.mount). */
  readonly mounted = new Set<WorkspaceLeaf>();

  constructor(
    private readonly app: App,
    private readonly host: WorkspaceHost,
  ) {
    super();
    this.mainLeaf = new WorkspaceLeaf(app, host);
    this.mdView = new MarkdownView(this.mainLeaf, host);
    setEditorInfoProvider(() => ({ app, file: this.getActiveFile(), editor: this.activeEditor?.editor }));
  }

  /** Mark the layout ready and run queued onLayoutReady callbacks. */
  setLayoutReady(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;
    for (const cb of this.readyCbs.splice(0)) {
      try {
        const r = cb() as unknown;
        if (r instanceof Promise) r.catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
    this.trigger('layout-ready');
  }
  onLayoutReady(cb: () => unknown): void {
    if (this.layoutReady) setTimeout(cb);
    else this.readyCbs.push(cb);
  }

  getActiveFile(): TFile | null {
    const p = this.host.getActiveFilePath();
    return p ? this.app.vault.getFileByPath(p) : null;
  }
  /** The main leaf, with a MarkdownView when a note is active. */
  get activeLeaf(): WorkspaceLeaf {
    const f = this.getActiveFile();
    if (f && f.extension === 'md') {
      this.mdView.file = f;
      this.mainLeaf.view = this.mdView;
    }
    return this.mainLeaf;
  }
  getMostRecentLeaf(): WorkspaceLeaf {
    return this.activeLeaf;
  }
  get activeEditor(): { editor: Editor; file: TFile | null } | null {
    const f = this.getActiveFile();
    if (!f || f.extension !== 'md') return null;
    this.mdView.file = f;
    return { editor: this.mdView.editor, file: f };
  }
  getActiveViewOfType<T>(type: abstract new (...args: any[]) => T): T | null {
    const leaf = this.activeLeaf;
    if (leaf.view instanceof type) return leaf.view as T;
    for (const l of this.mounted) if (l.view instanceof type) return l.view as T;
    return null;
  }
  getLeaf(_newLeaf?: boolean | 'tab' | 'split' | 'window'): WorkspaceLeaf {
    return new WorkspaceLeaf(this.app, this.host);
  }
  getUnpinnedLeaf(): WorkspaceLeaf {
    return this.activeLeaf;
  }
  createLeafBySplit(_leaf: WorkspaceLeaf): WorkspaceLeaf {
    return this.getLeaf();
  }
  getRightLeaf(_split: boolean): WorkspaceLeaf {
    return this.getLeaf();
  }
  getLeftLeaf(_split: boolean): WorkspaceLeaf {
    return this.getLeaf();
  }
  ensureSideLeaf(type: string, _side: string, opts?: { state?: unknown }): Promise<WorkspaceLeaf> {
    this.host.openView(type, (opts?.state as Record<string, unknown>) ?? {});
    return Promise.resolve(this.getLeaf());
  }
  async revealLeaf(_leaf: WorkspaceLeaf): Promise<void> {}
  setActiveLeaf(_leaf: WorkspaceLeaf, _params?: unknown): void {}
  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    const out = [...this.mounted].filter((l) => l.view.getViewType() === viewType);
    if (viewType === 'markdown' && this.activeLeaf.view === this.mdView) out.unshift(this.mainLeaf);
    return out;
  }
  getLeafById(_id: string): WorkspaceLeaf | null {
    return null;
  }
  detachLeavesOfType(viewType: string): void {
    for (const l of [...this.mounted]) if (l.view.getViewType() === viewType) l.detach();
  }
  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    cb(this.activeLeaf);
    for (const l of this.mounted) cb(l);
  }
  iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    this.iterateAllLeaves(cb);
  }
  async openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean | string, _openViewState?: unknown): Promise<void> {
    this.host.openLinkText(linktext, sourcePath, !!newLeaf);
  }
  getLastOpenFiles(): string[] {
    const f = this.getActiveFile();
    return f ? [f.path] : [];
  }
  /** Plugins call this after changing their editor extensions. */
  updateOptions(): void {
    this.onUpdateOptions?.();
  }
  onUpdateOptions: (() => void) | null = null;
  changeLayout(_layout: unknown): Promise<void> {
    return Promise.resolve();
  }
  getLayout(): Record<string, unknown> {
    return {};
  }
  moveLeafToPopout(leaf: WorkspaceLeaf): WorkspaceLeaf {
    return leaf;
  }
  openPopoutLeaf(): WorkspaceLeaf {
    return this.getLeaf();
  }
}

export type { TAbstractFile };
