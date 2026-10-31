import { App, Modal, Notice, setIcon } from 'obsidian';
import { t } from '../i18n';
import type { SyncLog, SyncLogEntry } from '../sync/SyncLog';

/**
 * setIcon with fallbacks: `'triangle-alert|alert-triangle'` tries each Lucide
 * name in turn (icon names changed across Obsidian's Lucide versions).
 */
export function setIconSafe(el: HTMLElement, names: string): void {
  for (const n of names.split('|')) {
    el.empty();
    setIcon(el, n);
    if (el.querySelector('svg')) return;
  }
}

/** A span holding a Lucide icon. */
export function icon(parent: HTMLElement, name: string, cls = ''): HTMLElement {
  const el = parent.createSpan({ cls });
  setIconSafe(el, name);
  return el;
}

export interface ButtonOpts {
  cta?: boolean;
  warning?: boolean;
  icon?: string;
  onClick: (btn: HTMLButtonElement) => unknown;
}

export function button(parent: HTMLElement, text: string, opts: ButtonOpts): HTMLButtonElement {
  const b = parent.createEl('button', { text });
  if (opts.cta) b.addClass('mod-cta');
  if (opts.warning) b.addClass('mod-warning');
  b.addEventListener('click', () => void opts.onClick(b));
  return b;
}

/** Run `fn` with the button disabled and a busy label. */
export async function withBusy<T>(btn: HTMLButtonElement, busyText: string, fn: () => Promise<T>): Promise<T> {
  const label = btn.textContent ?? '';
  btn.disabled = true;
  btn.setText(busyText);
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.setText(label);
  }
}

/** Labelled text input; `secret` adds a show/hide toggle. */
export function field(
  parent: HTMLElement,
  label: string,
  opts: { type?: string; value?: string; placeholder?: string; secret?: boolean; autocomplete?: string } = {},
): HTMLInputElement {
  const wrap = parent.createDiv({ cls: 'oc-field' });
  const id = `oc-${Math.random().toString(36).slice(2, 9)}`;
  wrap.createEl('label', { text: label, attr: { for: id } });
  const box = wrap.createDiv({ cls: opts.secret ? 'oc-input-wrap' : '' });
  const input = box.createEl('input', {
    attr: { id, type: opts.secret ? 'password' : (opts.type ?? 'text'), spellcheck: 'false' },
  });
  if (opts.value) input.value = opts.value;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.autocomplete) input.autocomplete = opts.autocomplete as AutoFill;
  if (opts.secret) {
    const eye = box.createEl('button', { cls: 'clickable-icon oc-eye', attr: { type: 'button', 'aria-label': label } });
    setIcon(eye, 'eye');
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      setIcon(eye, show ? 'eye-off' : 'eye');
      input.focus();
    });
  }
  return input;
}

/** Modal title with a leading icon. */
export function modalHeader(modal: Modal, iconName: string, title: string): void {
  modal.modalEl.addClass('oc-modal');
  modal.titleEl.empty();
  icon(modal.titleEl, iconName, 'oc-modal-icon');
  modal.titleEl.createSpan({ text: title });
}

export function errorBox(parent: HTMLElement): { set(msg: string | null): void } {
  const el = parent.createDiv({ cls: 'oc-error-box' });
  el.hide();
  return {
    set(msg) {
      if (msg) {
        el.setText(msg);
        el.show();
      } else el.hide();
    },
  };
}

// ── sync log ────────────────────────────────────────────────────────────────

const LEVEL_ICON: Record<SyncLogEntry['level'], string> = {
  info: 'dot|circle',
  success: 'check',
  error: 'circle-alert|alert-circle',
};

/**
 * Live view of the sync log with an "all / problems" filter, copy and clear.
 * Returns a cleanup function (unsubscribes).
 */
export function renderSyncLog(parent: HTMLElement, log: SyncLog, opts: { tall?: boolean } = {}): () => void {
  let filter: 'all' | 'problems' = 'all';
  const bar = parent.createDiv({ cls: 'oc-log-toolbar' });
  const chips = (['all', 'problems'] as const).map((f) => {
    const c = bar.createSpan({ cls: 'oc-chip', text: f === 'all' ? t('settings.log.all') : t('settings.log.problems') });
    c.addEventListener('click', () => {
      filter = f;
      draw();
    });
    return c;
  });
  bar.createSpan({ cls: 'oc-spacer' });
  const copy = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('action.copy') } });
  setIcon(copy, 'copy');
  copy.addEventListener('click', () => {
    const text = log
      .all()
      .map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text).then(() => new Notice(t('action.copied')));
  });
  const clear = bar.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('action.clear') } });
  setIconSafe(clear, 'trash-2|trash');
  clear.addEventListener('click', () => log.clear());

  const list = parent.createDiv({ cls: `oc-log${opts.tall ? ' is-tall' : ''}` });
  const draw = (): void => {
    chips.forEach((c, i) => c.toggleClass('is-active', (i === 0) === (filter === 'all')));
    list.empty();
    const entries = log
      .all()
      .filter((e) => filter === 'all' || e.level === 'error')
      .slice(-200)
      .reverse();
    if (entries.length === 0) {
      list.createDiv({ cls: 'oc-log-empty', text: filter === 'all' ? t('settings.log.empty') : t('settings.log.noProblems') });
      return;
    }
    for (const e of entries) {
      const row = list.createDiv({ cls: `oc-log-row is-${e.level}` });
      icon(row, LEVEL_ICON[e.level], 'oc-log-icon');
      row.createSpan({
        cls: 'oc-log-time',
        text: new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      });
      row.createSpan({ cls: 'oc-log-msg', text: e.message });
    }
  };
  draw();
  return log.onChange(draw);
}

export class SyncLogModal extends Modal {
  private cleanup: (() => void) | null = null;
  constructor(
    app: App,
    private readonly log: SyncLog,
  ) {
    super(app);
  }
  onOpen(): void {
    modalHeader(this, 'scroll-text|file-text', t('log.title'));
    this.cleanup = renderSyncLog(this.contentEl, this.log, { tall: true });
  }
  onClose(): void {
    this.cleanup?.();
    this.contentEl.empty();
  }
}
