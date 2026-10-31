import { App, Modal } from 'obsidian';
import { button, modalHeader } from '../ui/components';

export interface PromptOption<T extends string = string> {
  key: T;
  label: string;
  /** Highlight as the recommended (call-to-action) choice. */
  cta?: boolean;
  /** Style as destructive/warning. */
  warning?: boolean;
}

export interface PromptSpec<T extends string = string> {
  title: string;
  /** Lucide icon for the title (default: warning triangle). */
  icon?: string;
  message: string;
  /** Optional list of items (e.g. affected paths) rendered under the message. */
  details?: string[];
  options: Array<PromptOption<T>>;
}

/**
 * Serializes user prompts so simultaneous sync problems don't stack a wall of
 * modals — the next question opens only after the previous one is answered.
 */
export class PromptQueue {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Ask the user how to handle a sync problem. Resolves with the chosen option
 * key, or null when the modal is dismissed (Esc / close button) — callers
 * treat that as "decide later".
 */
export function askUser<T extends string>(app: App, spec: PromptSpec<T>): Promise<T | null> {
  return new Promise((resolve) => {
    new PromptModal<T>(app, spec, resolve).open();
  });
}

class PromptModal<T extends string> extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly spec: PromptSpec<T>,
    private readonly resolve: (choice: T | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    modalHeader(this, this.spec.icon ?? 'triangle-alert|alert-triangle', this.spec.title);
    const { contentEl } = this;
    for (const paragraph of this.spec.message.split('\n\n')) {
      contentEl.createEl('p', { text: paragraph });
    }
    if (this.spec.details?.length) {
      const list = contentEl.createEl('ul', { cls: 'oc-details' });
      for (const detail of this.spec.details) list.createEl('li', { text: detail });
    }
    // Long labels side by side get cramped — stack them.
    const stacked = this.spec.options.length > 2;
    const buttons = contentEl.createDiv({ cls: `oc-buttons${stacked ? ' is-stacked' : ''}` });
    const ordered = stacked ? this.spec.options : [...this.spec.options].reverse();
    for (const option of ordered) {
      const b = button(buttons, option.label, {
        cta: option.cta,
        warning: option.warning,
        onClick: () => this.finish(option.key),
      });
      if (option.cta) window.setTimeout(() => b.focus(), 0);
    }
  }

  private finish(choice: T | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(choice);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}
