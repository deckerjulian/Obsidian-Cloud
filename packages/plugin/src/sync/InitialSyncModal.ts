import { App, Modal } from 'obsidian';
import type ObsidianCloudPlugin from '../main';
import { t } from '../i18n';
import { button, icon, modalHeader, SyncLogModal } from '../ui/components';

/** The first sync of a vault: explain what happens, run it with live progress,
 *  then show what was transferred. */
export class InitialSyncModal extends Modal {
  private running = false;
  private unsub: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const s = this.plugin.settings;
    modalHeader(this, 'cloud-upload|upload-cloud|upload', t('initial.title'));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { cls: 'oc-lead', text: t('initial.intro', { email: s.accountEmail ?? '—' }) });
    contentEl.createEl('p', {
      text: s.vaultName ? t('initial.vault', { vault: s.vaultName }) : t('initial.root'),
    });
    const ul = contentEl.createEl('ul', { cls: 'oc-list' });
    for (const [ic, key] of [
      ['download', 'initial.point.down'],
      ['upload', 'initial.point.up'],
      ['shield-check|shield', 'initial.point.safe'],
    ] as const) {
      const li = ul.createEl('li');
      icon(li, ic);
      li.createSpan({ text: t(key) });
    }
    const buttons = contentEl.createDiv({ cls: 'oc-buttons' });
    button(buttons, t('action.notNow'), {
      onClick: () => {
        this.plugin.refreshSettingsTab();
        this.close();
      },
    });
    const start = button(buttons, t('action.startSync'), { cta: true, onClick: () => void this.runSync() });
    window.setTimeout(() => start.focus(), 0);
  }

  private async runSync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { contentEl } = this;
    contentEl.empty();
    modalHeader(this, 'refresh-cw', t('initial.running'));
    const progress = contentEl.createDiv({ cls: 'oc-progress' });
    icon(progress, 'loader-2|loader|refresh-cw', 'oc-spin');
    const col = progress.createDiv();
    col.style.minWidth = '0';
    col.createDiv({ text: t('initial.running.detail') });
    const line = col.createDiv({ cls: 'oc-progress-line' });
    // Mirror the latest log line as live progress.
    this.unsub = this.plugin.syncEngine.log.onChange(() => {
      const last = this.plugin.syncEngine.log.all().pop();
      if (last) line.setText(last.message);
    });

    const report = await this.plugin.syncEngine.start();
    this.unsub?.();
    this.unsub = null;
    this.running = false;
    this.plugin.refreshSettingsTab();

    contentEl.empty();
    if (!report) {
      modalHeader(this, 'triangle-alert|alert-triangle', t('initial.failed'));
      contentEl.createEl('p', { cls: 'oc-lead', text: t('initial.failed.detail') });
    } else {
      const problems = report.errors.length;
      modalHeader(this, problems ? 'triangle-alert|alert-triangle' : 'circle-check|check-circle', problems ? t('initial.warnings') : t('initial.done'));
      const stats = contentEl.createDiv({ cls: 'oc-stats' });
      const stat = (n: number, label: string, cls = ''): void => {
        const el = stats.createDiv({ cls: `oc-stat ${cls}` });
        el.createDiv({ cls: 'oc-stat-n', text: String(n) });
        el.createDiv({ cls: 'oc-stat-l', text: label });
      };
      stat(report.filesCreated, t('initial.stat.notes'));
      stat(report.foldersCreated, t('initial.stat.folders'));
      stat(report.pushed, t('initial.stat.uploaded'));
      if (problems) stat(problems, t('initial.stat.errors'), 'is-error');
    }
    const buttons = contentEl.createDiv({ cls: 'oc-buttons' });
    if (!report || report.errors.length) {
      button(buttons, t('action.showLog'), {
        onClick: () => {
          this.close();
          new SyncLogModal(this.app, this.plugin.syncEngine.log).open();
        },
      });
    }
    const done = button(buttons, t('action.done'), { cta: true, onClick: () => this.close() });
    done.focus();
  }

  onClose(): void {
    this.unsub?.();
    this.contentEl.empty();
  }
}
