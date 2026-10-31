import { App, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianCloudPlugin from './main';
import { checkServerHealth } from './api/health';
import { t } from './i18n';
import { describeStatus, setupSteps } from './ui/status';
import { button, icon, renderSyncLog, setIconSafe } from './ui/components';

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
  /** The server vault (isVault folder node id) this local vault mirrors. */
  vaultId: string | null;
  /** Its decrypted name, cached for display. */
  vaultName: string | null;
  /** Explicitly sync the shared root instead of a vault (pre-vault servers and
   *  existing installs). Without a vault or this flag, nothing syncs yet. */
  legacyRoot: boolean;
  /** Config push bookkeeping: config-relative path → `docId:mtime:size`
   *  last uploaded from this device (skips unchanged files across restarts). */
  configPushed: Record<string, string>;
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
  vaultId: null,
  vaultName: null,
  legacyRoot: false,
  configPushed: {},
};

export class ObsidianCloudSettingTab extends PluginSettingTab {
  private isOpen = false;
  private cleanups: Array<() => void> = [];
  private cardEl: HTMLElement | null = null;
  private serverOk = false;
  private urlCheckSeq = 0;
  private urlCheckTimer: number | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsidianCloudPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.isOpen = true;
    this.teardown();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('oc-settings');
    const plugin = this.plugin;
    const st = plugin.settings;
    const signedIn = plugin.authClient.hasSession();

    // ── status card (live) ──
    this.cardEl = containerEl.createDiv();
    this.renderCard();
    this.cleanups.push(plugin.onStateChange(() => this.renderCard()));

    // ── server & account ──
    new Setting(containerEl).setName(t('settings.connection')).setHeading();
    const url = new Setting(containerEl)
      .setName(t('settings.serverUrl'))
      .setDesc(signedIn ? t('settings.serverUrl.locked') : t('settings.serverUrl.desc'));
    const urlStatus = url.descEl.createDiv({ cls: 'oc-inline-status' });
    url.addText((text) => {
      text.setPlaceholder('https://cloud.example.com').setValue(st.serverUrl);
      text.inputEl.style.width = '260px';
      // Changing servers while signed in would mix two servers' bookkeeping.
      text.setDisabled(signedIn);
      text.onChange(async (value) => {
        st.serverUrl = value.trim().replace(/\/+$/, '');
        await plugin.saveSettings();
        if (this.urlCheckTimer !== null) window.clearTimeout(this.urlCheckTimer);
        this.urlCheckTimer = window.setTimeout(() => void this.checkServer(urlStatus), 500);
      });
      text.inputEl.addEventListener('blur', () => text.setValue(st.serverUrl));
    });
    void this.checkServer(urlStatus);

    const account = new Setting(containerEl)
      .setName(signedIn ? t('settings.account.signedIn', { email: st.accountEmail ?? '—' }) : t('settings.account.signedOut'))
      .setDesc(signedIn ? t('settings.account.signedIn.desc') : t('settings.account.signedOut.desc'));
    account.addButton((b) => {
      b.setButtonText(signedIn ? t('action.signOut') : t('action.signIn')).onClick(() => void plugin.toggleAuth());
      if (!signedIn) b.setCta();
    });

    // ── vault ──
    new Setting(containerEl).setName(t('settings.vault')).setHeading();
    const vaultName = st.vaultId ? (st.vaultName ?? st.vaultId) : st.legacyRoot ? t('vault.legacy') : null;
    const vault = new Setting(containerEl).setName(t('settings.vault.name')).setDesc(t('settings.vault.desc'));
    vault.nameEl.createSpan({
      cls: `oc-badge ${vaultName ? 'oc-tone-ok' : 'oc-tone-warn'}`,
      text: vaultName ?? t('settings.vault.none'),
    });
    if (st.vaultId) {
      vault.addExtraButton((b) =>
        b
          .setIcon('globe')
          .setTooltip(t('action.openWeb'))
          .onClick(() => plugin.openInWeb()),
      );
    }
    vault.addButton((b) =>
      b
        .setButtonText(vaultName ? t('action.changeVault') : t('action.chooseVault'))
        .setDisabled(!signedIn)
        .onClick(() => void plugin.promptVaultChoice(true)),
    );

    // ── encryption ──
    new Setting(containerEl).setName(t('settings.encryption')).setHeading();
    const e2ee = plugin.statusInput().e2ee;
    const enc = new Setting(containerEl);
    if (!signedIn) enc.setName(t('settings.encryption')).setDesc(t('settings.encryption.unknown'));
    else if (e2ee === 'unlocked') {
      enc.setName(t('settings.encryption.on')).setDesc(t('settings.encryption.on.desc'));
      enc.addButton((b) => b.setButtonText(t('action.lock')).onClick(() => plugin.lockEncryption()));
    } else if (e2ee === 'not-setup') {
      enc.setName(t('settings.encryption.notSetup')).setDesc(t('settings.encryption.notSetup.desc'));
      enc.addButton((b) => b.setButtonText(t('action.setUpEncryption')).setCta().onClick(() => void plugin.promptEncryption(true)));
    } else {
      enc.setName(t('settings.encryption.locked')).setDesc(t('settings.encryption.locked.desc'));
      enc.addButton((b) => b.setButtonText(t('action.unlock')).setCta().onClick(() => void plugin.promptEncryption(true)));
    }
    if (signedIn) {
      const badge = enc.nameEl.createSpan({ cls: `oc-badge is-icon ${e2ee === 'unlocked' ? 'oc-tone-ok' : 'oc-tone-warn'}` });
      setIconSafe(badge, e2ee === 'unlocked' ? 'shield-check|shield' : 'lock');
    }

    // ── synchronization ──
    new Setting(containerEl).setName(t('settings.sync')).setHeading();
    const interval = new Setting(containerEl)
      .setName(t('settings.interval'))
      .setDesc(t('settings.interval.desc', { s: st.syncIntervalSeconds }));
    interval.addSlider((sl) =>
      sl
        .setLimits(5, 120, 5)
        .setValue(st.syncIntervalSeconds)
        .setDynamicTooltip()
        .onChange(async (value) => {
          st.syncIntervalSeconds = value;
          interval.setDesc(t('settings.interval.desc', { s: value }));
          await plugin.saveSettings();
          if (plugin.authClient.hasSession()) plugin.syncEngine.startPolling();
        }),
    );
    new Setting(containerEl)
      .setName(t('settings.askConflicts'))
      .setDesc(t('settings.askConflicts.desc'))
      .addToggle((tg) =>
        tg.setValue(st.askOnConflict).onChange(async (value) => {
          st.askOnConflict = value;
          await plugin.saveSettings();
        }),
      );
    if (st.ignoredPaths.length > 0) {
      new Setting(containerEl).setName(t('settings.excluded')).setDesc(t('settings.excluded.desc'));
      const box = containerEl.createDiv({ cls: 'oc-excluded' });
      for (const path of st.ignoredPaths) {
        const row = box.createDiv({ cls: 'oc-excluded-row' });
        row.createSpan({ text: path });
        const b = row.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': t('action.resume') } });
        setIconSafe(b, 'rotate-ccw|undo');
        b.addEventListener('click', async () => {
          st.ignoredPaths = st.ignoredPaths.filter((p) => p !== path);
          await plugin.saveSettings();
          this.display();
        });
      }
    }

    // ── plugins & appearance (config push) ──
    if (st.vaultId) {
      new Setting(containerEl).setName(t('settings.config')).setHeading();
      const state = plugin.syncEngine.configSync.state;
      const cfg = new Setting(containerEl)
        .setName(
          state === 'denied' ? t('settings.config.state.denied') : state === 'ok' ? t('settings.config.state.ok') : t('settings.config.state.pending'),
        )
        .setDesc(
          `${t('settings.config.desc')} ${
            state === 'denied' ? t('settings.config.denied') : state === 'ok' ? t('settings.config.ok') : t('settings.config.waiting')
          }`,
        );
      const ic = createSpan({ cls: `oc-badge is-icon is-leading ${state === 'denied' ? 'oc-tone-warn' : state === 'ok' ? 'oc-tone-ok' : 'oc-tone-off'}` });
      setIconSafe(ic, state === 'denied' ? 'lock' : state === 'ok' ? 'check' : 'clock');
      cfg.nameEl.prepend(ic);
    }

    // ── sync log ──
    new Setting(containerEl).setName(t('settings.log')).setHeading();
    this.cleanups.push(renderSyncLog(containerEl.createDiv(), plugin.syncEngine.log));
  }

  /** The status card: what's going on, the next step, the setup checklist. */
  private renderCard(): void {
    const el = this.cardEl;
    if (!el) return;
    const input = this.plugin.statusInput();
    const v = describeStatus(input);
    el.empty();
    const card = el.createDiv({ cls: `oc-status-card oc-tone-${v.tone}` });
    icon(card, v.icon, `oc-card-icon${v.tone === 'busy' ? ' oc-spin' : ''}`);
    const body = card.createDiv({ cls: 'oc-card-body' });
    body.createDiv({ cls: 'oc-card-title', text: v.title });
    if (v.detail) body.createDiv({ cls: 'oc-card-detail', text: v.detail });
    const meta = [input.signedIn ? this.plugin.settings.accountEmail : null, this.plugin.settings.serverUrl].filter(Boolean).join(' · ');
    if (meta) body.createDiv({ cls: 'oc-card-meta', text: meta });

    const steps = setupSteps(input, this.serverOk);
    if (steps.some((s) => s.state !== 'done')) {
      const row = body.createDiv({ cls: 'oc-steps' });
      steps.forEach((s, i) => {
        const step = row.createSpan({ cls: `oc-step is-${s.state}` });
        const dot = step.createSpan({ cls: 'oc-step-dot' });
        if (s.state === 'done') setIconSafe(dot, 'check');
        else dot.setText(String(i + 1));
        step.createSpan({ text: s.label });
      });
    }

    const actions = body.createDiv({ cls: 'oc-card-actions' });
    if (v.action) button(actions, this.plugin.actionLabel(v.action), { cta: true, onClick: () => this.plugin.runAction(v.action) });
    if (v.tone === 'ok') {
      button(actions, t('action.syncNow'), { onClick: () => void this.plugin.syncEngine.syncNow() });
    }
    if (!actions.hasChildNodes()) actions.remove();
  }

  private async checkServer(el: HTMLElement): Promise<void> {
    const seq = ++this.urlCheckSeq;
    const url = this.plugin.settings.serverUrl;
    const show = (tone: string, iconName: string, text: string): void => {
      el.className = `oc-inline-status oc-tone-${tone}`;
      el.empty();
      icon(el, iconName, tone === 'busy' ? 'oc-spin' : '');
      el.createSpan({ text });
    };
    if (!url) {
      this.serverOk = false;
      show('warn', 'info', t('settings.server.empty'));
      this.renderCard();
      return;
    }
    show('busy', 'loader-2|loader', t('settings.server.checking'));
    const res = await checkServerHealth(url);
    if (seq !== this.urlCheckSeq || !el.isConnected) return;
    this.serverOk = res.ok;
    if (res.ok) show('ok', 'check', t('settings.server.ok'));
    else show('error', 'circle-alert|alert-circle', res.message);
    this.renderCard();
  }

  private teardown(): void {
    for (const c of this.cleanups.splice(0)) c();
    if (this.urlCheckTimer !== null) {
      window.clearTimeout(this.urlCheckTimer);
      this.urlCheckTimer = null;
    }
  }

  hide(): void {
    this.isOpen = false;
    this.teardown();
    this.cardEl = null;
    this.urlCheckSeq++;
  }

  /** Re-render if the settings tab is currently open (e.g. after sign-in). */
  refresh(): void {
    if (this.isOpen) this.display();
  }
}
