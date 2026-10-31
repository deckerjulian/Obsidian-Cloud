/**
 * Obsidian-compatible event emitter (`Events` in the Obsidian API): `on()`
 * returns an EventRef that can be passed to `offref()`; callbacks may carry a
 * `this` context. Shared by the vault store and the plugin API shim.
 */
export interface EventRef {
  e: Events;
  name: string;
  fn: (...args: unknown[]) => unknown;
  ctx?: unknown;
}

export class Events {
  private _handlers = new Map<string, EventRef[]>();

  on(name: string, callback: (...args: any[]) => any, ctx?: unknown): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    const list = this._handlers.get(name) ?? [];
    list.push(ref);
    this._handlers.set(name, list);
    return ref;
  }

  off(name: string, callback: (...args: any[]) => any): void {
    const list = this._handlers.get(name);
    if (!list) return;
    this._handlers.set(
      name,
      list.filter((r) => r.fn !== callback),
    );
  }

  offref(ref: EventRef): void {
    const list = this._handlers.get(ref.name);
    if (!list) return;
    this._handlers.set(
      ref.name,
      list.filter((r) => r !== ref),
    );
  }

  trigger(name: string, ...data: unknown[]): void {
    for (const ref of [...(this._handlers.get(name) ?? [])]) this.tryTrigger(ref, data);
  }

  tryTrigger(ref: EventRef, data: unknown[]): void {
    try {
      ref.fn.apply(ref.ctx, data);
    } catch (err) {
      // A misbehaving plugin handler must not break the emitter for others.
      console.error(err);
    }
  }
}
