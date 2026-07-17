import { App, Modal, Notice, Setting } from 'obsidian';
import type ObsidianCloudPlugin from '../main';

/** Collects the E2EE passphrase to set up or unlock the user's key on this device. */
export class EncryptionModal extends Modal {
  private passphrase = '';
  private confirm = '';

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
    private readonly mode: 'setup' | 'unlock',
    private readonly onSuccess: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const isSetup = this.mode === 'setup';
    contentEl.createEl('h3', {
      text: isSetup ? 'Set up end-to-end encryption' : 'Unlock encryption',
    });
    contentEl.createEl('p', {
      cls: 'mod-muted',
      text: isSetup
        ? 'Choose a separate encryption passphrase. It never leaves this device. If you lose it, your encrypted notes cannot be recovered — not even by an admin.'
        : 'Enter your encryption passphrase to decrypt your notes on this device.',
    });

    new Setting(contentEl).setName('Encryption passphrase').addText((t) => {
      t.inputEl.type = 'password';
      t.onChange((v) => (this.passphrase = v));
      t.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isSetup) void this.submit();
      });
    });

    if (isSetup) {
      new Setting(contentEl).setName('Confirm passphrase').addText((t) => {
        t.inputEl.type = 'password';
        t.onChange((v) => (this.confirm = v));
      });
    }

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isSetup ? 'Set up' : 'Unlock')
        .setCta()
        .onClick(() => void this.submit()),
    );
  }

  private async submit(): Promise<void> {
    const isSetup = this.mode === 'setup';
    if (this.passphrase.length < 8) {
      new Notice('Use at least 8 characters.');
      return;
    }
    if (isSetup && this.passphrase !== this.confirm) {
      new Notice('Passphrases do not match.');
      return;
    }
    try {
      if (isSetup) await this.plugin.e2ee.setup(this.passphrase);
      else await this.plugin.e2ee.unlock(this.passphrase);
      new Notice(isSetup ? 'Encryption enabled.' : 'Encryption unlocked.');
      this.close();
      this.onSuccess();
    } catch (err) {
      new Notice(
        isSetup
          ? `Setup failed: ${(err as Error).message}`
          : 'Wrong passphrase, or the stored key is corrupted.',
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
