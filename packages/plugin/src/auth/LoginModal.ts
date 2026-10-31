import { App, Modal, Notice } from 'obsidian';
import type ObsidianCloudPlugin from '../main';
import { checkServerHealth } from '../api/health';
import { t } from '../i18n';
import { button, errorBox, field, icon, modalHeader, withBusy } from '../ui/components';

/**
 * Sign-in dialog. The server address can be fixed right here (no detour via
 * the settings); it is health-checked as you type, and Sign in only goes
 * through once the server answers.
 */
export class LoginModal extends Modal {
  private serverOk = false;
  private checkSeq = 0;
  private checkTimer: number | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
    private readonly onSuccess: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    modalHeader(this, 'cloud', t('login.title'));
    const form = this.contentEl.createDiv({ cls: 'oc-form' });

    const url = field(form, t('login.server'), {
      type: 'url',
      value: this.plugin.settings.serverUrl,
      placeholder: 'https://cloud.example.com',
    });
    const status = form.createDiv({ cls: 'oc-inline-status' });
    status.style.marginTop = '-8px';
    const email = field(form, t('login.email'), { type: 'email', autocomplete: 'username' });
    if (this.plugin.settings.accountEmail) email.value = this.plugin.settings.accountEmail;
    const password = field(form, t('login.password'), { secret: true, autocomplete: 'current-password' });
    const error = errorBox(form);

    const buttons = this.contentEl.createDiv({ cls: 'oc-buttons' });
    button(buttons, t('action.cancel'), { onClick: () => this.close() });
    const submit = button(buttons, t('login.submit'), { cta: true, onClick: () => void doSubmit() });

    const setStatus = (tone: 'busy' | 'ok' | 'error' | 'off', text: string, iconName: string): void => {
      status.className = `oc-inline-status oc-tone-${tone}`;
      status.empty();
      icon(status, iconName, tone === 'busy' ? 'oc-spin' : '');
      status.createSpan({ text });
    };
    const check = async (): Promise<void> => {
      const value = url.value.trim().replace(/\/+$/, '');
      const seq = ++this.checkSeq;
      this.serverOk = false;
      if (!value) {
        setStatus('off', t('settings.server.empty'), 'info');
        return;
      }
      setStatus('busy', t('settings.server.checking'), 'loader-2|loader');
      const res = await checkServerHealth(value);
      if (seq !== this.checkSeq) return; // a newer check is running
      this.serverOk = res.ok;
      if (res.ok) {
        setStatus('ok', t('settings.server.ok'), 'check');
        if (this.plugin.settings.serverUrl !== value) {
          this.plugin.settings.serverUrl = value;
          await this.plugin.saveSettings();
        }
      } else setStatus('error', res.message, 'circle-alert|alert-circle');
    };
    url.addEventListener('input', () => {
      if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
      this.checkTimer = window.setTimeout(() => void check(), 500);
    });

    const doSubmit = async (): Promise<void> => {
      error.set(null);
      if (!email.value.trim() || !password.value) {
        error.set(t('login.missing'));
        (email.value.trim() ? password : email).focus();
        return;
      }
      if (!this.serverOk) await check();
      if (!this.serverOk) {
        error.set(t('login.serverDown'));
        url.focus();
        return;
      }
      await withBusy(submit, t('login.busy'), async () => {
        try {
          const user = await this.plugin.authClient.login(email.value.trim(), password.value);
          new Notice(t('login.done', { email: user.email }));
          this.close();
          this.onSuccess();
        } catch (err) {
          error.set(t('login.failed', { msg: (err as Error).message }));
          password.select();
        }
      });
    };
    for (const input of [url, email, password]) {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (input === email && !password.value) password.focus();
        else void doSubmit();
      });
    }

    void check();
    window.setTimeout(() => (this.plugin.settings.serverUrl ? (email.value ? password : email) : url).focus(), 0);
  }

  onClose(): void {
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer);
    this.checkSeq++;
    this.contentEl.empty();
  }
}
