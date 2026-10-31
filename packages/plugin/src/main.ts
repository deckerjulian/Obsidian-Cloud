import { Menu, Notice, Plugin, TFile, editorInfoField, type TAbstractFile } from 'obsidian';
import { EditorState } from '@codemirror/state';
import { ObsidianCloudSettings, DEFAULT_SETTINGS, ObsidianCloudSettingTab } from './settings';
import { HttpClient } from './api/HttpClient';
import { TokenStore } from './auth/TokenStore';
import { AuthClient } from './auth/AuthClient';
import { LoginModal } from './auth/LoginModal';
import { SyncEngine } from './sync/SyncEngine';
import { InitialSyncModal } from './sync/InitialSyncModal';
import { E2eeManager } from './e2ee/E2eeManager';
import { EncryptionModal } from './e2ee/EncryptionModal';
import { chooseVault, type VaultChoice } from './sync/VaultPicker';
import { DEVICE_STATE_STORAGE_KEY, mergeDeviceState, splitDeviceState } from './deviceState';
import { t } from './i18n';
import { describeStatus, type E2eeState, type NextAction, type StatusInput, type SyncStatus } from './ui/status';
import { PLUGIN_CSS } from './ui/styles';
import { SyncLogModal, setIconSafe } from './ui/components';

export type { SyncStatus } from './ui/status';

export default class ObsidianCloudPlugin extends Plugin {
  settings!: ObsidianCloudSettings;
  http!: HttpClient;
  tokenStore!: TokenStore;
  authClient!: AuthClient;
  e2ee!: E2eeManager;
  syncEngine!: SyncEngine;
  private settingTab!: ObsidianCloudSettingTab;
  private statusBar?: HTMLElement;
  /** True once Obsidian has fully indexed the vault. Offline-deletion detection
   *  waits for this so an un-indexed file is never mistaken for a deletion. */
  layoutReady = false;
  private syncState: SyncStatus = 'offline';
  private e2eeState: E2eeState = 'unknown';
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;
  private readonly stateListeners = new Set<() => void>();
  private lastReadOnlyNoticeAt = 0;
  private vaultPickerOpen = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.tokenStore = new TokenStore(this);
    this.http = new HttpClient({
      getBaseUrl: () => this.settings.serverUrl,
      getAccessToken: () => this.tokenStore.getAccessToken(),
      refresh: () => this.authClient.refresh(),
      onUnauthorized: () => this.setStatus('offline'),
    });
    this.authClient = new AuthClient(this.http, this.tokenStore);
    this.e2ee = new E2eeManager(this.http, () => this.settings.accountId);
    this.syncEngine = new SyncEngine(this);

    this.settingTab = new ObsidianCloudSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.setAttribute('data-tooltip-position', 'top');
    this.registerDomEvent(this.statusBar, 'click', (evt) => this.showMenu(evt));
    this.injectStyles();
    this.setStatus('offline');
    // Keep "synced 3 minutes ago" current.
    this.registerInterval(window.setInterval(() => this.renderStatusBar(), 30_000));

    this.addRibbonIcon('cloud', 'Obsidian Cloud', (evt) => this.showMenu(evt));
    this.addCommand({
      id: 'sign-in-out',
      name: t('cmd.signInOut'),
      callback: () => void this.toggleAuth(),
    });
    this.addCommand({
      id: 'sync-now',
      name: t('cmd.syncNow'),
      callback: () => void this.syncEngine.syncNow(),
    });
    this.addCommand({
      id: 'encryption',
      name: t('cmd.encryption'),
      callback: () => void this.promptEncryption(true),
    });
    this.addCommand({
      id: 'choose-vault',
      name: t('cmd.chooseVault'),
      callback: () => void this.promptVaultChoice(true),
    });
    this.addCommand({
      id: 'open-in-web',
      name: t('cmd.openWeb'),
      callback: () => this.openInWeb(this.app.workspace.getActiveFile()?.path),
    });
    this.addCommand({
      id: 'show-log',
      name: t('cmd.showLog'),
      callback: () => new SyncLogModal(this.app, this.syncEngine.log).open(),
    });

    // Enforce server permissions in the editor: without the 'edit' capability
    // the keystroke itself is rejected (the vault 'modify' event only fires
    // after the write, far too late to prevent local/server divergence).
    // Block exactly the direct input events (typing/paste/drop, delete, drag,
    // undo/redo). Anything else — unannotated or Obsidian-internal transactions,
    // above all the sync writing server changes into the open editor — must
    // pass through, so the match is an explicit allow-nothing-else list.
    const blockedUserEvents = ['input', 'delete', 'move', 'undo', 'redo'];
    this.registerEditorExtension(
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr;
        if (!blockedUserEvents.some((e) => tr.isUserEvent(e))) return tr;
        const file = tr.startState.field(editorInfoField, false)?.file;
        if (!file || this.syncEngine.canEditPath(file.path)) return tr;
        this.noticeReadOnly(file.path);
        return [];
      }),
    );

    // Live content bridge + lazy session open.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) void this.syncEngine.openFile(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.syncEngine.handleFileModified(file);
      }),
    );

    // Structure push — registered after layout-ready so the initial vault load
    // isn't mistaken for a flood of newly created files.
    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.registerEvent(
        this.app.vault.on('create', (file: TAbstractFile) => void this.syncEngine.handleCreate(file)),
      );
      this.registerEvent(
        this.app.vault.on('delete', (file: TAbstractFile) => void this.syncEngine.handleDelete(file)),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) =>
          void this.syncEngine.handleRename(file, oldPath),
        ),
      );
    });

    // Restore an existing session in the background, then activate sync.
    if (this.authClient.hasSession()) {
      void this.authClient.refresh().then(async (ok) => {
        if (!ok) {
          this.setStatus('offline');
          this.refreshSettingsTab();
          // Offline start (network error, session kept): keep polling so sync
          // resumes automatically once the server is reachable again.
          if (this.authClient.hasSession()) this.syncEngine.startPolling();
          return;
        }
        this.refreshSettingsTab();
        // The engine marks the initial sync done itself, only after the first
        // CLEAN reconcile — so a locked/offline start stays a safe merge.
        await this.syncEngine.start();
        void this.promptEncryption();
      });
    }

    console.log('Obsidian-Cloud plugin loaded');
  }

  onunload(): void {
    this.syncEngine?.stop();
    console.log('Obsidian-Cloud plugin unloaded');
  }

  async toggleAuth(): Promise<void> {
    if (this.authClient.hasSession()) {
      this.syncEngine.stop();
      this.e2ee.lock();
      this.setE2eeState('unknown');
      await this.authClient.logout();
      // The sync bookkeeping belongs to THIS account/server. Kept around, a
      // sign-in to a different account would treat every previously tracked
      // path as "deleted on the server" and mass-trash local files.
      this.settings.trackedPaths = [];
      this.settings.docIds = {};
      this.settings.configPushed = {};
      await this.saveSettings();
      this.setStatus('offline');
      this.refreshSettingsTab();
      new Notice(t('notice.signedOut'));
    } else {
      new LoginModal(this.app, this, () => void this.onSignedIn()).open();
    }
  }

  /** Runs after a successful interactive sign-in. */
  private async onSignedIn(): Promise<void> {
    this.setStatus('online');
    this.refreshSettingsTab();
    // Without a chosen vault, start() only polls; the first unlocked reconcile
    // offers the vault picker, which then runs the initial sync itself.
    const vaultChosen = !!this.settings.vaultId || this.settings.legacyRoot;
    if (vaultChosen && !this.settings.initialSyncDone) {
      new InitialSyncModal(this.app, this).open();
    } else {
      await this.syncEngine.start();
    }
    void this.promptEncryption();
  }

  /**
   * Ask which server vault this local vault mirrors (requires sign-in and
   * unlocked encryption — vault names are encrypted). `force` = opened by the
   * user, so explain why it can't open instead of failing silently.
   */
  async promptVaultChoice(force: boolean): Promise<void> {
    if (this.vaultPickerOpen) return;
    if (!this.authClient.hasSession()) {
      if (force) new Notice(t('notice.signInFirst'));
      return;
    }
    if (!this.e2ee.unlocked) {
      if (force) new Notice(t('notice.unlockFirst'));
      return;
    }
    this.vaultPickerOpen = true;
    let choice: VaultChoice | null;
    try {
      choice = await chooseVault(this);
    } catch (err) {
      new Notice(t('notice.vaultsFailed', { msg: (err as Error).message }));
      return;
    } finally {
      this.vaultPickerOpen = false;
    }
    if (choice) await this.selectVault(choice);
  }

  /**
   * Switch the server vault. The sync bookkeeping belongs to the previous
   * vault — kept, every tracked path would look "deleted on the server" and be
   * trashed locally — so it is reset and the next sync is a fresh, merge-only
   * initial sync.
   */
  async selectVault(choice: VaultChoice): Promise<void> {
    const s = this.settings;
    const same =
      choice.kind === 'vault' ? s.vaultId === choice.id : !s.vaultId && s.legacyRoot;
    if (same) {
      if (choice.kind === 'vault') s.vaultName = choice.name;
      await this.saveSettings();
      this.refreshSettingsTab();
      void this.syncEngine.syncNow();
      return;
    }
    this.syncEngine.stop();
    s.vaultId = choice.kind === 'vault' ? choice.id : null;
    s.vaultName = choice.kind === 'vault' ? choice.name : null;
    s.legacyRoot = choice.kind === 'legacy';
    s.trackedPaths = [];
    s.docIds = {};
    s.configPushed = {};
    s.initialSyncDone = false;
    await this.saveSettings();
    this.refreshSettingsTab();
    new InitialSyncModal(this.app, this).open();
  }

  /**
   * Ensure end-to-end encryption is set up and unlocked on this device. Opens a
   * passphrase modal when needed; structure sync works regardless, but note
   * content can only be decrypted once unlocked.
   */
  async promptEncryption(force = false): Promise<void> {
    if (!this.authClient.hasSession()) {
      if (force) new Notice(t('notice.signInFirst'));
      return;
    }
    if (this.e2ee.unlocked) {
      this.setE2eeState('unlocked');
      return;
    }
    // Reuse a key persisted on this device — no passphrase prompt on relaunch.
    if (await this.e2ee.tryRestore()) {
      this.setE2eeState('unlocked');
      this.syncEngine.onEncryptionUnlocked();
      return;
    }
    let status: 'not-setup' | 'locked' | 'unlocked';
    try {
      status = await this.e2ee.status();
    } catch {
      return; // offline / server unreachable — try again next session
    }
    this.setE2eeState(status);
    if (status === 'unlocked') return;
    new EncryptionModal(this.app, this, status === 'not-setup' ? 'setup' : 'unlock', () => {
      this.setE2eeState('unlocked');
      this.syncEngine.onEncryptionUnlocked();
    }).open();
  }

  refreshSettingsTab(): void {
    this.settingTab?.refresh();
    this.stateChanged();
  }

  /** Rejected-edit feedback, throttled so held-down keys don't stack notices. */
  private noticeReadOnly(path: string): void {
    const now = Date.now();
    if (now - this.lastReadOnlyNoticeAt < 2000) return;
    this.lastReadOnlyNoticeAt = now;
    new Notice(t('notice.readOnly', { path }));
  }

  // ── status ────────────────────────────────────────────────────────────────
  setStatus(state: SyncStatus, error?: string): void {
    this.syncState = state;
    if (state === 'online') this.lastError = null;
    else if (error) this.lastError = error;
    this.stateChanged();
  }

  setE2eeState(s: E2eeState): void {
    this.e2eeState = s;
    this.stateChanged();
  }

  /** Record a successful sync and refresh the status UI. */
  markSynced(): void {
    this.lastSyncedAt = Date.now();
    this.stateChanged();
  }

  /** Inputs of the status UI (status bar, menu, settings card). */
  statusInput(): StatusInput {
    const s = this.settings;
    return {
      signedIn: this.authClient?.hasSession() ?? false,
      e2ee: this.e2ee?.unlocked ? 'unlocked' : this.e2eeState,
      vaultName: s.vaultId ? (s.vaultName ?? s.vaultId) : s.legacyRoot ? t('vault.legacy') : null,
      initialSyncDone: s.initialSyncDone,
      sync: this.syncState,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }

  /** Subscribe to status changes (settings tab). Returns an unsubscribe. */
  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private stateChanged(): void {
    this.renderStatusBar();
    for (const fn of this.stateListeners) fn();
  }

  /** Run the next step a status suggests (status card / menu button). */
  runAction(action: NextAction): void {
    switch (action) {
      case 'signIn':
        void this.toggleAuth();
        break;
      case 'setUpEncryption':
      case 'unlock':
        void this.promptEncryption(true);
        break;
      case 'chooseVault':
        void this.promptVaultChoice(true);
        break;
      case 'startSync':
        new InitialSyncModal(this.app, this).open();
        break;
      case 'retry':
        void this.syncEngine.syncNow();
        break;
    }
  }

  actionLabel(action: NextAction): string {
    return {
      signIn: t('action.signIn'),
      setUpEncryption: t('action.setUpEncryption'),
      unlock: t('action.unlock'),
      chooseVault: t('action.chooseVault'),
      startSync: t('action.startSync'),
      retry: t('action.retry'),
    }[action ?? 'retry'];
  }

  /** The web app at this vault (and note, if given). */
  webUrl(path?: string | null): string | null {
    const s = this.settings;
    if (!s.serverUrl) return null;
    if (!s.vaultId) return s.serverUrl;
    return `${s.serverUrl}/#/vault/${s.vaultId}${path ? `/${encodeURIComponent(path)}` : ''}`;
  }

  openInWeb(path?: string | null): void {
    if (!this.settings.vaultId) {
      new Notice(t('notice.noWeb'));
      return;
    }
    const url = this.webUrl(path);
    if (url) window.open(url);
  }

  lockEncryption(): void {
    this.e2ee.lock();
    this.setE2eeState('locked');
    new Notice(t('notice.locked'));
    this.refreshSettingsTab();
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.id = 'obsidian-cloud-styles';
    style.textContent = PLUGIN_CSS;
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  private renderStatusBar(): void {
    const el = this.statusBar;
    if (!el || !this.settings) return;
    const v = describeStatus(this.statusInput());
    el.empty();
    el.className = `status-bar-item plugin-obsidian-cloud mod-clickable oc-statusbar is-${v.tone}`;
    const ic = el.createSpan({ cls: `oc-sb-icon${v.tone === 'busy' ? ' oc-spin' : ''}` });
    setIconSafe(ic, v.icon);
    el.createSpan({ text: v.short });
    el.setAttribute('aria-label', t('status.tooltip', { title: v.title, detail: v.detail }));
  }

  /** Cloud menu (status-bar / ribbon click): status, next step, common actions. */
  showMenu(evt: MouseEvent): void {
    const v = describeStatus(this.statusInput());
    const signedIn = this.authClient.hasSession();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(v.title).setIcon(v.icon.split('|')[0]).setDisabled(true));
    if (v.action && v.action !== 'retry') {
      menu.addItem((i) => i.setTitle(this.actionLabel(v.action)).setIcon('arrow-right').onClick(() => this.runAction(v.action)));
    }
    if (signedIn) {
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle(t('action.syncNow')).setIcon('refresh-cw').onClick(() => void this.syncEngine.syncNow()),
      );
      if (this.settings.vaultId) {
        const file = this.app.workspace.getActiveFile();
        menu.addItem((i) =>
          i
            .setTitle(file ? t('action.openNoteWeb') : t('action.openWeb'))
            .setIcon('globe')
            .onClick(() => this.openInWeb(file?.path)),
        );
      }
      menu.addItem((i) =>
        i
          .setTitle(this.settings.vaultId || this.settings.legacyRoot ? t('action.changeVault') : t('action.chooseVault'))
          .setIcon('folder-sync')
          .onClick(() => void this.promptVaultChoice(true)),
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(t('action.showLog')).setIcon('scroll-text').onClick(() => new SyncLogModal(this.app, this.syncEngine.log).open()),
    );
    menu.addItem((i) => i.setTitle(t('action.settings')).setIcon('settings').onClick(() => this.openSettings()));
    if (signedIn) {
      if (this.e2ee.unlocked) {
        menu.addItem((i) => i.setTitle(t('action.lock')).setIcon('lock').onClick(() => this.lockEncryption()));
      }
      menu.addItem((i) => i.setTitle(t('action.signOut')).setIcon('log-out').onClick(() => void this.toggleAuth()));
    } else {
      menu.addItem((i) => i.setTitle(t('action.signIn')).setIcon('log-in').onClick(() => void this.toggleAuth()));
    }
    menu.showAtMouseEvent(evt);
  }

  /** Open this plugin's settings tab. */
  openSettings(): void {
    const setting = (this.app as unknown as {
      setting: { open(): void; openTabById(id: string): void };
    }).setting;
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  async loadSettings(): Promise<void> {
    // data.json is shared between devices (it lives in the synced vault);
    // per-device state comes from this device's storage — see deviceState.ts.
    const data = ((await this.loadData()) ?? null) as Record<string, unknown> | null;
    const { merged, migrated } = mergeDeviceState(data, this.loadDeviceState());
    // Clone the defaults: arrays/objects from DEFAULT_SETTINGS must never be
    // shared (and later mutated) across loads.
    this.settings = Object.assign({}, structuredClone(DEFAULT_SETTINGS), merged);
    // Installs from before vaults existed synced the shared root: keep doing
    // that rather than suddenly stopping (they can switch in the settings).
    const s = this.settings;
    const upgraded = !s.vaultId && !s.legacyRoot && (s.initialSyncDone || s.trackedPaths.length > 0);
    if (upgraded) s.legacyRoot = true;
    if (migrated || upgraded) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    const { shared, device } = splitDeviceState(this.settings as unknown as Record<string, unknown>);
    this.saveDeviceState(device);
    await this.saveData(shared);
  }

  /** Vault-scoped, device-local storage (Obsidian ≥ 1.8.7), with a
   *  window.localStorage fallback keyed by the vault name. */
  private deviceStorage(): { load(): unknown; save(v: string): void } {
    const app = this.app as unknown as {
      loadLocalStorage?: (key: string) => unknown;
      saveLocalStorage?: (key: string, data: unknown) => void;
    };
    if (typeof app.loadLocalStorage === 'function' && typeof app.saveLocalStorage === 'function') {
      return {
        load: () => app.loadLocalStorage!(DEVICE_STATE_STORAGE_KEY),
        save: (v) => app.saveLocalStorage!(DEVICE_STATE_STORAGE_KEY, v),
      };
    }
    const key = `${DEVICE_STATE_STORAGE_KEY}:${this.app.vault.getName()}`;
    return {
      load: () => window.localStorage.getItem(key),
      save: (v) => window.localStorage.setItem(key, v),
    };
  }

  private loadDeviceState(): Record<string, unknown> | null {
    try {
      // Stored as a JSON string ourselves, so it round-trips whether or not
      // the storage layer (de)serializes on its own.
      let v = this.deviceStorage().load();
      if (typeof v === 'string') v = JSON.parse(v);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private saveDeviceState(state: Record<string, unknown>): void {
    try {
      this.deviceStorage().save(JSON.stringify(state));
    } catch (err) {
      console.error('Obsidian-Cloud: could not persist device state', err);
    }
  }
}
