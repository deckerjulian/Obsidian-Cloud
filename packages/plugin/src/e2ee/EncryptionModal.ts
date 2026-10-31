import { App, Modal, Notice } from 'obsidian';
import type ObsidianCloudPlugin from '../main';
import { t } from '../i18n';
import { button, errorBox, field, icon, modalHeader, withBusy } from '../ui/components';

/** Rough passphrase strength: 0 weak, 1 okay, 2 strong. */
export function passphraseStrength(p: string): 0 | 1 | 2 {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s|-/].filter((r) => r.test(p)).length;
  const score = p.length + classes * 3;
  return p.length < 8 ? 0 : score >= 24 ? 2 : score >= 16 ? 1 : 0;
}

/** Collects the E2EE passphrase to set up or unlock the user's key on this device. */
export class EncryptionModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
    private readonly mode: 'setup' | 'unlock',
    private readonly onSuccess: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const isSetup = this.mode === 'setup';
    modalHeader(this, isSetup ? 'shield-check|shield' : 'lock', isSetup ? t('enc.setup.title') : t('enc.unlock.title'));
    const { contentEl } = this;
    contentEl.createEl('p', { cls: 'oc-lead', text: isSetup ? t('enc.setup.intro') : t('enc.unlock.intro') });

    const form = contentEl.createDiv({ cls: 'oc-form' });
    const pass = field(form, t('enc.passphrase'), { secret: true, autocomplete: isSetup ? 'new-password' : 'current-password' });
    let confirm: HTMLInputElement | null = null;
    if (isSetup) {
      const meterWrap = form.createDiv();
      meterWrap.style.marginTop = '-6px';
      const meter = meterWrap.createDiv({ cls: 'oc-meter' }).createDiv();
      const hint = meterWrap.createDiv({ cls: 'oc-note' });
      const update = (): void => {
        const v = pass.value;
        const s = passphraseStrength(v);
        meter.style.width = v ? `${[34, 67, 100][s]}%` : '0';
        meter.style.background = ['var(--color-red)', 'var(--color-orange)', 'var(--color-green)'][s];
        hint.setText(v ? [t('enc.strength.weak'), t('enc.strength.ok'), t('enc.strength.good')][s] : '');
      };
      pass.addEventListener('input', update);
      update();
      confirm = field(form, t('enc.confirm'), { secret: true, autocomplete: 'new-password' });
      const warn = form.createDiv({ cls: 'oc-callout oc-tone-warn' });
      icon(warn, 'triangle-alert|alert-triangle');
      warn.createSpan({ text: t('enc.setup.warn') });
    }
    const error = errorBox(form);

    const buttons = contentEl.createDiv({ cls: 'oc-buttons' });
    button(buttons, t('action.notNow'), { onClick: () => this.close() });
    const submit = button(buttons, isSetup ? t('enc.submit.setup') : t('enc.submit.unlock'), {
      cta: true,
      onClick: () => void doSubmit(),
    });

    const doSubmit = async (): Promise<void> => {
      error.set(null);
      if (pass.value.length < 8) {
        error.set(t('enc.tooShort'));
        pass.focus();
        return;
      }
      if (confirm && pass.value !== confirm.value) {
        error.set(t('enc.mismatch'));
        confirm.focus();
        return;
      }
      await withBusy(submit, t('enc.busy'), async () => {
        try {
          if (isSetup) await this.plugin.e2ee.setup(pass.value);
          else await this.plugin.e2ee.unlock(pass.value);
          new Notice(isSetup ? t('enc.enabled') : t('enc.unlocked'));
          this.close();
          this.onSuccess();
        } catch (err) {
          error.set(isSetup ? t('enc.failed', { msg: (err as Error).message }) : t('enc.wrong'));
          pass.select();
        }
      });
    };
    for (const input of [pass, confirm].filter((x): x is HTMLInputElement => !!x)) {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (input === pass && confirm) confirm.focus();
        else void doSubmit();
      });
    }
    window.setTimeout(() => pass.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
