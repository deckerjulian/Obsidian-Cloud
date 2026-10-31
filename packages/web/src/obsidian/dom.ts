/**
 * Obsidian's global DOM augmentations (`createEl`, `el.empty()`, `addClass`,
 * `Array.prototype.contains`, …). Community plugins assume these exist on every
 * element, so they are installed once, globally, before any plugin loads. The
 * web app's own renderer uses them too.
 */

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}
type Cb<T> = (el: T) => void;

declare global {
  interface Node {
    detach(): void;
    empty(): void;
    insertAfter<T extends Node>(node: T, child: Node | null): T;
    indexOf(other: Node): number;
    setChildrenInPlace(children: Node[]): void;
    appendText(val: string): void;
    instanceOf<T>(type: { new (): T }): this is T;
    doc: Document;
    win: Window;
    constructorWin: Window;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: Cb<HTMLElementTagNameMap[K]>,
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: Cb<HTMLDivElement>): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, callback?: Cb<HTMLSpanElement>): HTMLSpanElement;
    createSvg<K extends keyof SVGElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: Cb<SVGElementTagNameMap[K]>,
    ): SVGElementTagNameMap[K];
  }
  interface Element {
    getText(): string;
    setText(val: string | DocumentFragment): void;
    addClass(...classes: string[]): void;
    addClasses(classes: string[]): void;
    removeClass(...classes: string[]): void;
    removeClasses(classes: string[]): void;
    toggleClass(classes: string | string[], value: boolean): void;
    hasClass(cls: string): boolean;
    setAttr(qualifiedName: string, value: string | number | boolean | null): void;
    setAttrs(obj: Record<string, string | number | boolean | null>): void;
    getAttr(qualifiedName: string): string | null;
    matchParent(selector: string, lastParent?: Element): Element | null;
    getCssPropertyValue(property: string, pseudoElement?: string): string;
    isActiveElement(): boolean;
    find(selector: string): HTMLElement;
    findAll(selector: string): HTMLElement[];
    findAllSelf(selector: string): HTMLElement[];
  }
  interface HTMLElement {
    show(): void;
    hide(): void;
    toggle(show: boolean): void;
    toggleVisibility(visible: boolean): void;
    isShown(): boolean;
    setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
    setCssProps(props: Record<string, string>): void;
    readonly innerWidth: number;
    readonly innerHeight: number;
    onClickEvent(listener: (this: HTMLElement, ev: MouseEvent) => unknown, options?: boolean | AddEventListenerOptions): void;
    onNodeInserted(listener: () => unknown, once?: boolean): () => void;
    onWindowMigrated(listener: (win: Window) => unknown): () => void;
    trigger(eventType: string): void;
  }
  interface Array<T> {
    contains(target: T): boolean;
    remove(target: T): void;
    first(): T | undefined;
    last(): T | undefined;
    unique(): T[];
    findLastIndex(predicate: (value: T) => boolean): number;
    shuffle(): this;
  }
  interface String {
    contains(target: string): boolean;
    format(...args: string[]): string;
  }
  interface Math {
    clamp(value: number, min: number, max: number): number;
    square(value: number): number;
  }
  interface ObjectConstructor {
    isEmpty(object: Record<string, unknown>): boolean;
    each<T>(object: Record<string, T>, callback: (value: T, key?: string) => boolean | void, context?: unknown): boolean;
  }
  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: Cb<HTMLElementTagNameMap[K]>,
  ): HTMLElementTagNameMap[K];
  function createDiv(o?: DomElementInfo | string, callback?: Cb<HTMLDivElement>): HTMLDivElement;
  function createSpan(o?: DomElementInfo | string, callback?: Cb<HTMLSpanElement>): HTMLSpanElement;
  function createFragment(callback?: Cb<DocumentFragment>): DocumentFragment;
  function createSvg<K extends keyof SVGElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: Cb<SVGElementTagNameMap[K]>,
  ): SVGElementTagNameMap[K];
  function fish(selector: string): HTMLElement | null;
  function fishAll(selector: string): HTMLElement[];
  function sleep(ms: number): Promise<void>;
  function nextFrame(): Promise<void>;
  // eslint-disable-next-line no-var
  var activeWindow: Window;
  // eslint-disable-next-line no-var
  var activeDocument: Document;
}

function applyInfo(el: Element, o: DomElementInfo | string | undefined): void {
  if (o === undefined) return;
  const info: DomElementInfo = typeof o === 'string' ? { cls: o } : o;
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(' ');
    el.classList.add(...classes.filter(Boolean));
  }
  if (info.text !== undefined) {
    if (typeof info.text === 'string') el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr) {
    for (const [k, v] of Object.entries(info.attr)) {
      if (v === null || v === false) el.removeAttribute(k);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (info.title !== undefined) el.setAttribute('title', info.title);
  if (info.value !== undefined && 'value' in el) (el as HTMLInputElement).value = info.value;
  if (info.type !== undefined) el.setAttribute('type', info.type);
  if (info.placeholder !== undefined) el.setAttribute('placeholder', info.placeholder);
  if (info.href !== undefined) el.setAttribute('href', info.href);
  if (info.parent) {
    if (info.prepend) info.parent.insertBefore(el, info.parent.firstChild);
    else info.parent.appendChild(el);
  }
}

function make<E extends Element>(el: E, parent: Node | null, o?: DomElementInfo | string, cb?: Cb<E>): E {
  applyInfo(el, o);
  if (parent && !(typeof o === 'object' && o.parent)) {
    if (typeof o === 'object' && o.prepend) parent.insertBefore(el, parent.firstChild);
    else parent.appendChild(el);
  }
  cb?.(el);
  return el;
}

let installed = false;

export function installObsidianDom(): void {
  if (installed) return;
  installed = true;
  const N = Node.prototype as unknown as Record<string, unknown>;
  const E = Element.prototype as unknown as Record<string, unknown>;
  const H = HTMLElement.prototype as unknown as Record<string, unknown>;
  const define = (target: Record<string, unknown>, name: string, value: unknown): void => {
    if (name in target) return;
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };

  define(N, 'detach', function (this: Node) {
    this.parentNode?.removeChild(this);
  });
  define(N, 'empty', function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define(N, 'insertAfter', function <T extends Node>(this: Node, node: T, child: Node | null): T {
    this.insertBefore(node, child ? child.nextSibling : this.firstChild);
    return node;
  });
  define(N, 'indexOf', function (this: Node, other: Node) {
    return Array.prototype.indexOf.call(this.childNodes, other);
  });
  define(N, 'setChildrenInPlace', function (this: Node, children: Node[]) {
    (this as unknown as Node).empty();
    for (const c of children) this.appendChild(c);
  });
  define(N, 'appendText', function (this: Node, val: string) {
    this.appendChild(document.createTextNode(val));
  });
  define(N, 'instanceOf', function (this: Node, type: { new (): unknown }) {
    return this instanceof type;
  });
  for (const [name, get] of [
    ['doc', function (this: Node) { return this.ownerDocument ?? document; }],
    ['win', function (this: Node) { return (this.ownerDocument ?? document).defaultView ?? window; }],
    ['constructorWin', function () { return window; }],
  ] as const) {
    if (!(name in N)) Object.defineProperty(N, name, { get, configurable: true });
  }
  define(N, 'createEl', function (this: Node, tag: string, o?: DomElementInfo | string, cb?: Cb<Element>) {
    return make(document.createElement(tag), this, o, cb);
  });
  define(N, 'createDiv', function (this: Node, o?: DomElementInfo | string, cb?: Cb<Element>) {
    return make(document.createElement('div'), this, o, cb);
  });
  define(N, 'createSpan', function (this: Node, o?: DomElementInfo | string, cb?: Cb<Element>) {
    return make(document.createElement('span'), this, o, cb);
  });
  define(N, 'createSvg', function (this: Node, tag: string, o?: DomElementInfo | string, cb?: Cb<Element>) {
    return make(document.createElementNS('http://www.w3.org/2000/svg', tag), this, o, cb);
  });

  define(E, 'getText', function (this: Element) {
    return this.textContent ?? '';
  });
  define(E, 'setText', function (this: Element, val: string | DocumentFragment) {
    if (typeof val === 'string') this.textContent = val;
    else {
      (this as unknown as Node).empty();
      this.appendChild(val);
    }
  });
  define(E, 'addClass', function (this: Element, ...c: string[]) {
    this.classList.add(...c.flatMap((x) => x.split(' ')).filter(Boolean));
  });
  define(E, 'addClasses', function (this: Element, c: string[]) {
    this.classList.add(...c.filter(Boolean));
  });
  define(E, 'removeClass', function (this: Element, ...c: string[]) {
    this.classList.remove(...c.flatMap((x) => x.split(' ')).filter(Boolean));
  });
  define(E, 'removeClasses', function (this: Element, c: string[]) {
    this.classList.remove(...c);
  });
  define(E, 'toggleClass', function (this: Element, c: string | string[], value: boolean) {
    for (const x of Array.isArray(c) ? c : [c]) this.classList.toggle(x, value);
  });
  define(E, 'hasClass', function (this: Element, c: string) {
    return this.classList.contains(c);
  });
  define(E, 'setAttr', function (this: Element, k: string, v: string | number | boolean | null) {
    if (v === null || v === false) this.removeAttribute(k);
    else this.setAttribute(k, v === true ? '' : String(v));
  });
  define(E, 'setAttrs', function (this: Element, obj: Record<string, string | number | boolean | null>) {
    for (const [k, v] of Object.entries(obj)) (this as Element).setAttr(k, v);
  });
  define(E, 'getAttr', function (this: Element, k: string) {
    return this.getAttribute(k);
  });
  define(E, 'matchParent', function (this: Element, selector: string, last?: Element) {
    let cur: Element | null = this;
    while (cur && cur !== last) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  });
  define(E, 'getCssPropertyValue', function (this: Element, p: string, pseudo?: string) {
    return getComputedStyle(this, pseudo).getPropertyValue(p);
  });
  define(E, 'isActiveElement', function (this: Element) {
    return document.activeElement === this;
  });
  define(E, 'find', function (this: Element, s: string) {
    return this.querySelector(s);
  });
  define(E, 'findAll', function (this: Element, s: string) {
    return Array.from(this.querySelectorAll(s));
  });
  define(E, 'findAllSelf', function (this: Element, s: string) {
    const all = Array.from(this.querySelectorAll(s));
    return this.matches(s) ? [this, ...all] : all;
  });

  define(H, 'show', function (this: HTMLElement) {
    this.style.display = '';
  });
  define(H, 'hide', function (this: HTMLElement) {
    this.style.display = 'none';
  });
  define(H, 'toggle', function (this: HTMLElement, show: boolean) {
    this.style.display = show ? '' : 'none';
  });
  define(H, 'toggleVisibility', function (this: HTMLElement, v: boolean) {
    this.style.visibility = v ? '' : 'hidden';
  });
  define(H, 'isShown', function (this: HTMLElement) {
    return this.offsetParent !== null || getComputedStyle(this).display !== 'none';
  });
  define(H, 'setCssStyles', function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  });
  define(H, 'setCssProps', function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  });
  if (!('innerWidth' in H)) {
    Object.defineProperty(H, 'innerWidth', { get(this: HTMLElement) { return this.clientWidth; }, configurable: true });
    Object.defineProperty(H, 'innerHeight', { get(this: HTMLElement) { return this.clientHeight; }, configurable: true });
  }
  define(H, 'onClickEvent', function (this: HTMLElement, fn: (ev: MouseEvent) => unknown, opts?: boolean | AddEventListenerOptions) {
    this.addEventListener('click', fn as EventListener, opts);
    this.addEventListener('auxclick', fn as EventListener, opts);
  });
  define(H, 'onNodeInserted', function (this: HTMLElement, fn: () => unknown, once?: boolean) {
    let done = false;
    const check = (): void => {
      if (done || !this.isConnected) return;
      if (once) done = true;
      fn();
    };
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true });
    queueMicrotask(check);
    return () => obs.disconnect();
  });
  define(H, 'onWindowMigrated', function () {
    return () => undefined;
  });
  define(H, 'trigger', function (this: HTMLElement, type: string) {
    this.dispatchEvent(new Event(type));
  });
  // Delegated listeners: el.on('click', '.selector', handler)
  define(H, 'on', function (
    this: HTMLElement,
    type: string,
    selector: string,
    listener: (this: HTMLElement, ev: Event, delegateTarget: HTMLElement) => unknown,
    options?: boolean | AddEventListenerOptions,
  ) {
    const wrapped = (ev: Event): void => {
      const t = (ev.target as Element | null)?.closest?.(selector);
      if (t && this.contains(t)) listener.call(t as HTMLElement, ev, t as HTMLElement);
    };
    (listener as unknown as { _ocWrapped?: unknown })._ocWrapped = wrapped;
    this.addEventListener(type, wrapped, options);
  });
  define(H, 'off', function (this: HTMLElement, type: string, _selector: string, listener: unknown, options?: boolean) {
    const w = (listener as { _ocWrapped?: EventListener })._ocWrapped;
    if (w) this.removeEventListener(type, w, options);
  });

  const A = Array.prototype as unknown as Record<string, unknown>;
  define(A, 'contains', function (this: unknown[], t: unknown) {
    return this.includes(t);
  });
  define(A, 'remove', function (this: unknown[], t: unknown) {
    const i = this.indexOf(t);
    if (i >= 0) this.splice(i, 1);
  });
  define(A, 'first', function (this: unknown[]) {
    return this[0];
  });
  define(A, 'last', function (this: unknown[]) {
    return this[this.length - 1];
  });
  define(A, 'unique', function (this: unknown[]) {
    return [...new Set(this)];
  });
  define(A, 'shuffle', function (this: unknown[]) {
    for (let i = this.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this[i], this[j]] = [this[j], this[i]];
    }
    return this;
  });
  const S = String.prototype as unknown as Record<string, unknown>;
  define(S, 'contains', function (this: string, t: string) {
    return this.includes(t);
  });
  define(S, 'format', function (this: string, ...args: string[]) {
    return this.replace(/\{(\d+)\}/g, (m, i: string) => args[Number(i)] ?? m);
  });
  const M = Math as unknown as Record<string, unknown>;
  define(M, 'clamp', (v: number, min: number, max: number) => Math.min(max, Math.max(min, v)));
  define(M, 'square', (v: number) => v * v);
  const O = Object as unknown as Record<string, unknown>;
  define(O, 'isEmpty', (o: Record<string, unknown>) => Object.keys(o).length === 0);
  define(O, 'each', (o: Record<string, unknown>, cb: (v: unknown, k?: string) => boolean | void, ctx?: unknown) => {
    for (const [k, v] of Object.entries(o)) if (cb.call(ctx, v, k) === false) return false;
    return true;
  });

  const G = globalThis as unknown as Record<string, unknown>;
  G.createEl = (tag: string, o?: DomElementInfo | string, cb?: Cb<Element>) => make(document.createElement(tag), null, o, cb);
  G.createDiv = (o?: DomElementInfo | string, cb?: Cb<Element>) => make(document.createElement('div'), null, o, cb);
  G.createSpan = (o?: DomElementInfo | string, cb?: Cb<Element>) => make(document.createElement('span'), null, o, cb);
  G.createSvg = (tag: string, o?: DomElementInfo | string, cb?: Cb<Element>) =>
    make(document.createElementNS('http://www.w3.org/2000/svg', tag), null, o, cb);
  G.createFragment = (cb?: Cb<DocumentFragment>) => {
    const f = document.createDocumentFragment();
    cb?.(f);
    return f;
  };
  G.fish = (s: string) => document.querySelector(s);
  G.fishAll = (s: string) => Array.from(document.querySelectorAll(s));
  G.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  G.nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
  G.activeWindow = window;
  G.activeDocument = document;
  const DF = DocumentFragment.prototype as unknown as Record<string, unknown>;
  for (const name of ['createEl', 'createDiv', 'createSpan', 'empty', 'appendText', 'createSvg']) {
    if (!(name in DF)) define(DF, name, N[name]);
  }
}
