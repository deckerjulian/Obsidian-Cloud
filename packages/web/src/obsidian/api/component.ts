import { Events, type EventRef } from '../../vault/events';

export { Events };
export type { EventRef };

/**
 * Obsidian's `Component`: a lifecycle owner. Children load with their parent
 * and everything registered (events, DOM listeners, intervals, callbacks) is
 * torn down on unload — this is what makes plugin unloading leak-free.
 */
export class Component {
  _loaded = false;
  _children: Component[] = [];
  _events: Array<() => void> = [];

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const c of [...this._children]) c.load();
  }
  onload(): void {}

  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const c of this._children.splice(0).reverse()) c.unload();
    for (const cb of this._events.splice(0).reverse()) {
      try {
        cb();
      } catch (err) {
        console.error(err);
      }
    }
    this.onunload();
  }
  onunload(): void {}

  addChild<T extends Component>(child: T): T {
    this._children.push(child);
    if (this._loaded) child.load();
    return child;
  }
  removeChild<T extends Component>(child: T): T {
    const i = this._children.indexOf(child);
    if (i >= 0) {
      this._children.splice(i, 1);
      child.unload();
    }
    return child;
  }
  register(cb: () => unknown): void {
    this._events.push(cb as () => void);
  }
  registerEvent(ref: EventRef): void {
    this.register(() => ref.e.offref(ref));
  }
  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: (ev: Event) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback as EventListener, options);
    this.register(() => el.removeEventListener(type, callback as EventListener, options));
  }
  registerScopeEvent(handler: { scope?: Scope }): void {
    this.register(() => handler.scope?.unregister(handler as KeymapEventHandler));
  }
  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}

/** A Component bound to a rendered element (Dataview's views extend this). */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: HTMLElement) {
    super();
  }
}

// ── keyboard scopes ─────────────────────────────────────────────────────────
export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';
export interface KeymapEventHandler {
  scope: Scope;
  modifiers: string | null;
  key: string | null;
  func: (evt: KeyboardEvent, ctx: unknown) => unknown;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function eventModifiers(evt: KeyboardEvent | MouseEvent): string[] {
  const m: string[] = [];
  if (isMac ? evt.metaKey : evt.ctrlKey) m.push('Mod');
  if (evt.ctrlKey) m.push('Ctrl');
  if (evt.metaKey) m.push('Meta');
  if (evt.altKey) m.push('Alt');
  if (evt.shiftKey) m.push('Shift');
  return m;
}

export class Scope {
  keys: KeymapEventHandler[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventHandler['func']): KeymapEventHandler {
    const h: KeymapEventHandler = { scope: this, modifiers: modifiers ? modifiers.join(',') : null, key, func };
    this.keys.push(h);
    return h;
  }
  unregister(handler: KeymapEventHandler): void {
    this.keys = this.keys.filter((k) => k !== handler);
  }
  /** Dispatch a keydown; returns true when a handler consumed it. */
  handleKey(evt: KeyboardEvent): boolean {
    const mods = eventModifiers(evt);
    for (const h of this.keys) {
      if (h.key !== null && h.key.toLowerCase() !== evt.key.toLowerCase()) continue;
      if (h.modifiers !== null) {
        const want = h.modifiers.split(',').filter(Boolean);
        const relevant = mods.filter((m) => m !== (isMac ? 'Meta' : 'Ctrl') || !want.includes('Mod'));
        if (want.length !== relevant.length || !want.every((w) => mods.includes(w))) continue;
      }
      const res = h.func(evt, { modifiers: mods.join(','), key: evt.key, vkey: evt.key });
      if (res !== true) {
        evt.preventDefault();
        return true;
      }
    }
    return this.parent ? this.parent.handleKey(evt) : false;
  }
}

export const Keymap = {
  isModEvent(evt?: MouseEvent | KeyboardEvent | null): boolean | 'tab' | 'split' | 'window' {
    if (!evt) return false;
    if ((isMac ? evt.metaKey : evt.ctrlKey) && evt.altKey && evt.shiftKey) return 'window';
    if ((isMac ? evt.metaKey : evt.ctrlKey) && evt.altKey) return 'split';
    if (isMac ? evt.metaKey : evt.ctrlKey) return 'tab';
    if ((evt as MouseEvent).button === 1) return 'tab';
    return false;
  },
  isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    const e = evt as KeyboardEvent;
    switch (modifier) {
      case 'Mod':
        return isMac ? e.metaKey : e.ctrlKey;
      case 'Ctrl':
        return e.ctrlKey;
      case 'Meta':
        return e.metaKey;
      case 'Shift':
        return e.shiftKey;
      case 'Alt':
        return e.altKey;
    }
  },
};
