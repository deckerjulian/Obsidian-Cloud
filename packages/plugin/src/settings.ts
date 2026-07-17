import { App, PluginSettingTab, Setting, type TextComponent } from 'obsidian';
import type ObsidianCloudPlugin from './main';
import { checkServerHealth } from './api/health';
import type { SyncLogEntry } from './sync/SyncLog';

export interface ObsidianCloudSettings {
  /** Base URL of the backend, e.g. https://vault.example.com */
  serverUrl: string;
  /** Persisted refresh token (access token is kept in memory only). */
  refreshToken: string | null;
  /** Last logged-in account email, for display. */
  accountEmail: string | null;
  /** Last logged-in account id, used to wrap document keys for this user. */
  accountId: string | null;
  /** Vault paths this plugin previously synced (to detect server-side deletions). */
  trackedPaths: string[];
  /** Map of vault path → server docId, for opening live document sessions. */
  docIds: Record<string, string>;
  /** Background reconcile interval in seconds. */
  syncIntervalSeconds: number;
  /** Whether the one-time "synchronize now?" prompt has been shown. */
  initialSyncDone: boolean;
  /** Ask via popup how sync conflicts/problems should be handled. When off,
   *  conflicts keep both versions and failures are only logged. */
  askOnConflict: boolean;
  /** Paths the user chose to never synchronize. */
  ignoredPaths: string[];
  /** Signature of the admin set last backfilled with this user's content keys
   *  (admins can read all files). Re-runs the backfill when it changes. */
  adminKeySignature: string | null;
  /** Signature of the user set the (manager's) central plugin folder keys were
   *  last distributed to. Re-keys the plugin subtree when users join/leave. */
  pluginGranteeSignature: string | null;
}

export const DEFAULT_SETTINGS: ObsidianCloudSettings = {
  serverUrl: 'http://localhost:8080',
  refreshToken: null,
  accountEmail: null,
  accountId: null,
  trackedPaths: [],
  docIds: {},
  syncIntervalSeconds: 20,
  initialSyncDone: false,
  askOnConflict: true,
  ignoredPaths: [],
  adminKeySignature: null,
  pluginGranteeSignature: null,
};

const LEVEL_COLOR: Record<SyncLogEntry['level'], string> = {
  info: 'var(--text-muted)',
  success: 'var(--text-success, #3fb950)',
  error: 'var(--text-error, #e5534b)',
};

export class ObsidianCloudSettingTab extends PluginSettingTab {
  private isOpen = false;
  private unsubLog: (() => void) | null = null;
  private logEl: HTMLElement | null = null;
  private urlStatusEl: HTMLElement | null = null;
  private urlCheckTimer: number | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.isOpen = true;
    const { containerEl } = this;
    containerEl.empty();

    // ── Connection ──
    new Setting(containerEl).setName('Connection').setHeading();
    let urlText: TextComponent | null = null;
    const urlSetting = new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Base URL of your Obsidian-Cloud backend.')
      .addText((text) => {
        urlText = text;
        text
          .setPlaceholder('http://localhost:8080')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim().replace(/\/+$/, '');
            await this.plugin.saveSettings();
            // Re-check as you type, debounced, so the status stays current.
            this.scheduleServerCheck(text);
          });
        // Also validate immediately when the field is left.
        text.inputEl.addEventListener('blur', () => void this.checkServerUrl(text));
      });
    // Persistent status line under the field, refreshed each time the tab opens.
    this.urlStatusEl = urlSetting.descEl.createDiv({ cls: 'oc-url-status' });
    this.urlStatusEl.style.marginTop = '4px';
    this.urlStatusEl.style.fontSize = '12px';
    if (urlText) void this.checkServerUrl(urlText);

    // ── Account ──
    new Setting(containerEl).setName('Account').setHeading();
    const signedIn = this.plugin.authClient.hasSession();
    new Setting(containerEl)
      .setName(signedIn ? `Signed in as ${this.plugin.settings.accountEmail ?? 'unknown'}` : 'Not signed in')
      .setDesc(signedIn ? 'Your vault syncs with the server according to your permissions.' : 'Sign in to start syncing.')
      .addButton((btn) =>
        btn
          .setButtonText(signedIn ? 'Sign out' : 'Sign in')
          .setCta()
          .onClick(() => void this.plugin.toggleAuth()),
      );

    // ── Synchronization ──
    new Setting(containerEl).setName('Synchronization').setHeading();
    new Setting(containerEl)
      .setName('Background sync interval')
      .setDesc('How often the plugin checks the server for changes.')
      .addSlider((s) =>
        s
          .setLimits(5, 120, 5)
          .setValue(this.plugin.settings.syncIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalSeconds = value;
            await this.plugin.saveSettings();
            if (signedIn) this.plugin.syncEngine.startPolling();
          }),
      );
    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Run a full reconciliation immediately.')
      .addButton((btn) =>
        btn.setButtonText('Sync now').onClick(() => void this.plugin.syncEngine.syncNow()),
      );
    new Setting(containerEl)
      .setName('Ask how to handle sync problems')
      .setDesc(
        'Show a popup when a file conflicts or cannot be synchronized. ' +
          'When off, conflicts keep both versions and failures are only logged.',
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.askOnConflict).onChange(async (value) => {
          this.plugin.settings.askOnConflict = value;
          await this.plugin.saveSettings();
        }),
      );
    if (this.plugin.settings.ignoredPaths.length > 0) {
      new Setting(containerEl)
        .setName('Excluded from sync')
        .setDesc(
          `${this.plugin.settings.ignoredPaths.length} path(s) marked "never sync": ` +
            this.plugin.settings.ignoredPaths.join(', '),
        )
        .addButton((btn) =>
          btn.setButtonText('Sync them again').onClick(async () => {
            this.plugin.settings.ignoredPaths = [];
            await this.plugin.saveSettings();
            this.display();
          }),
        );
    }

    // ── Sync log ──
    new Setting(containerEl)
      .setName('Sync log')
      .setHeading()
      .addButton((btn) =>
        btn.setButtonText('Clear').onClick(() => {
          this.plugin.syncEngine.log.clear();
        }),
      );
    this.logEl = containerEl.createDiv();
    this.logEl.style.cssText =
      'max-height:240px;overflow:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:8px;font-family:var(--font-monospace);font-size:12px;line-height:1.5;background:var(--background-secondary);';
    this.renderLog();

    this.unsubLog?.();
    this.unsubLog = this.plugin.syncEngine.log.onChange(() => this.renderLog());
  }

  /** Debounce reachability checks while the user is still typing the URL. */
  private scheduleServerCheck(text: TextComponent): void {
    if (this.urlCheckTimer !== null) window.clearTimeout(this.urlCheckTimer);
    this.setUrlStatus('Checking server…', 'var(--text-muted)');
    this.urlCheckTimer = window.setTimeout(() => {
      this.urlCheckTimer = null;
      void this.checkServerUrl(text, false);
    }, 600);
  }

  /** Reachability check for the entered server URL; shows an inline status.
   *  `normalize` reflects the trimmed value back into the field (skip while typing). */
  private async checkServerUrl(text: TextComponent, normalize = true): Promise<void> {
    const el = this.urlStatusEl;
    if (!el) return;
    const url = this.plugin.settings.serverUrl;
    if (!url) {
      this.setUrlStatus('Enter a server URL.', 'var(--text-muted)');
      return;
    }
    if (normalize) text.setValue(url); // reflect the normalized value (trimmed, no trailing /)
    this.setUrlStatus('Checking server…', 'var(--text-muted)');
    const res = await checkServerHealth(url);
    // The tab may have been re-rendered or closed while we awaited.
    if (this.urlStatusEl !== el) return;
    if (res.ok) {
      this.setUrlStatus('Server is reachable ✓', 'var(--text-success, #3fb950)');
    } else {
      this.setUrlStatus(res.message, 'var(--text-error, #e5534b)');
    }
  }

  private setUrlStatus(text: string, color: string): void {
    if (!this.urlStatusEl) return;
    this.urlStatusEl.setText(text);
    this.urlStatusEl.style.color = color;
  }

  private renderLog(): void {
    const el = this.logEl;
    if (!el) return;
    el.empty();
    const entries = this.plugin.syncEngine.log.all().slice(-100).reverse();
    if (entries.length === 0) {
      el.createEl('div', { text: 'No sync activity yet.', cls: 'oc-log-empty' }).style.color =
        'var(--text-faint)';
      return;
    }
    for (const entry of entries) {
      const row = el.createDiv();
      row.style.color = LEVEL_COLOR[entry.level];
      const time = new Date(entry.time).toLocaleTimeString();
      row.setText(`${time}  ${entry.message}`);
    }
  }

  hide(): void {
    this.isOpen = false;
    this.unsubLog?.();
    this.unsubLog = null;
    this.logEl = null;
    this.urlStatusEl = null;
    if (this.urlCheckTimer !== null) {
      window.clearTimeout(this.urlCheckTimer);
      this.urlCheckTimer = null;
    }
  }

  /** Re-render if the settings tab is currently open (e.g. after sign-in). */
  refresh(): void {
    if (this.isOpen) this.display();
  }
}
