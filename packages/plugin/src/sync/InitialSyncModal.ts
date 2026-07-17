import { App, Modal, Setting } from 'obsidian';
import type ObsidianCloudPlugin from '../main';

/** One-time prompt on first sign-in: offer to synchronize and show a report. */
export class InitialSyncModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Synchronize your vault?' });
    contentEl.createEl('p', {
      text:
        `You're signed in as ${this.plugin.settings.accountEmail ?? 'your account'}. ` +
        'Download the folders and notes you have access to into this vault, upload your ' +
        'local notes, and keep everything in sync?',
    });
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText('Not now').onClick(() => {
          void this.markDone();
          this.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText('Synchronize')
          .setCta()
          .onClick(() => void this.runSync()),
      );
  }

  private async runSync(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Synchronizing…' });
    contentEl.createEl('p', { text: 'Reconciling your vault with the server.' });

    const report = await this.plugin.syncEngine.start();
    await this.markDone();

    contentEl.empty();
    if (!report) {
      contentEl.createEl('h3', { text: 'Sync failed' });
      contentEl.createEl('p', { text: 'See the sync log under Settings → Obsidian Cloud.' });
    } else {
      contentEl.createEl('h3', {
        text: report.errors.length ? 'Sync finished with warnings' : 'Sync complete',
      });
      const ul = contentEl.createEl('ul');
      ul.createEl('li', { text: `${report.foldersCreated} folders created` });
      ul.createEl('li', { text: `${report.filesCreated} notes created` });
      if (report.pushed) ul.createEl('li', { text: `${report.pushed} local files uploaded` });
      if (report.removed) ul.createEl('li', { text: `${report.removed} removed` });
      if (report.errors.length) {
        ul.createEl('li', { text: `${report.errors.length} errors — see the sync log in settings` });
      }
    }
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Done')
        .setCta()
        .onClick(() => this.close()),
    );
  }

  private async markDone(): Promise<void> {
    this.plugin.settings.initialSyncDone = true;
    await this.plugin.saveSettings();
    this.plugin.refreshSettingsTab();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
