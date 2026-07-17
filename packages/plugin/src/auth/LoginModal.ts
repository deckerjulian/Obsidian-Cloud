import { App, Modal, Notice, Setting, type ButtonComponent } from 'obsidian';
import type ObsidianCloudPlugin from '../main';
import { checkServerHealth } from '../api/health';

/** Collects credentials and signs in via the backend. Signing in is only
 *  enabled once the configured server URL answers the health endpoint. */
export class LoginModal extends Modal {
  private username = '';
  private password = '';
  private serverOk = false;
  private signInBtn: ButtonComponent | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
    private readonly onSuccess: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Sign in to Obsidian Cloud' });
    contentEl.createEl('p', {
      text: this.plugin.settings.serverUrl,
      cls: 'mod-muted',
    });
    this.statusEl = contentEl.createEl('p');
    this.statusEl.style.fontSize = '13px';

    new Setting(contentEl).setName('Username').addText((t) =>
      t.setPlaceholder('email or directory username').onChange((v) => (this.username = v.trim())),
    );

    new Setting(contentEl).setName('Password').addText((t) => {
      t.inputEl.type = 'password';
      t.onChange((v) => (this.password = v));
      t.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.submit();
      });
    });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('Check again').onClick(() => void this.verifyServer()),
      )
      .addButton((b) => {
        this.signInBtn = b;
        b.setButtonText('Sign in')
          .setCta()
          .setDisabled(true)
          .onClick(() => void this.submit());
      });

    void this.verifyServer();
  }

  /** Health-check the configured server; the Sign in button stays disabled
   *  until the backend actually answers. */
  private async verifyServer(): Promise<void> {
    this.serverOk = false;
    this.signInBtn?.setDisabled(true);
    if (this.statusEl) {
      this.statusEl.setText('Checking server…');
      this.statusEl.style.color = 'var(--text-muted)';
    }
    const res = await checkServerHealth(this.plugin.settings.serverUrl);
    if (!this.statusEl) return; // modal closed meanwhile
    if (res.ok) {
      this.serverOk = true;
      this.signInBtn?.setDisabled(false);
      this.statusEl.setText('Server is reachable ✓');
      this.statusEl.style.color = 'var(--text-success, #3fb950)';
    } else {
      this.statusEl.setText(`${res.message} Fix the server URL in the plugin settings.`);
      this.statusEl.style.color = 'var(--text-error, #e5534b)';
    }
  }

  private async submit(): Promise<void> {
    if (!this.serverOk) {
      new Notice('Server is not reachable — fix the server URL in the settings first.');
      return;
    }
    if (!this.username || !this.password) {
      new Notice('Enter a username and password.');
      return;
    }
    try {
      const user = await this.plugin.authClient.login(this.username, this.password);
      new Notice(`Signed in as ${user.email}`);
      this.close();
      this.onSuccess();
    } catch (err) {
      new Notice(`Sign-in failed: ${(err as Error).message}`);
    }
  }

  onClose(): void {
    this.statusEl = null;
    this.signInBtn = null;
    this.contentEl.empty();
  }
}
