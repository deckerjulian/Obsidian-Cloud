import { Menu, Notice, Plugin, TFile, editorInfoField, setIcon, type TAbstractFile } from 'obsidian';
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

export type SyncStatus = 'offline' | 'online' | 'syncing' | 'error';

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
  private e2eeState: 'unknown' | 'not-setup' | 'locked' | 'unlocked' = 'unknown';
  private lastSyncedAt: number | null = null;
  private lastReadOnlyNoticeAt = 0;

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
    this.statusBar.style.cursor = 'pointer';
    this.statusBar.setAttribute('aria-label', 'Obsidian Cloud');
    this.registerDomEvent(this.statusBar, 'click', (evt) => this.showMenu(evt));
    this.injectStyles();
    this.setStatus('offline');

    this.addRibbonIcon('cloud', 'Obsidian Cloud', (evt) => this.showMenu(evt));
    this.addCommand({
      id: 'sign-in-out',
      name: 'Sign in / out',
      callback: () => void this.toggleAuth(),
    });
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncEngine.syncNow(),
    });
    this.addCommand({
      id: 'encryption',
      name: 'Set up / unlock encryption',
      callback: () => void this.promptEncryption(),
    });
    this.addCommand({
      id: 'publish-plugin',
      name: 'Publish a plugin to the central folder',
      callback: () => void this.syncEngine.pluginSync.publish(),
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

  openAuthUi(): void {
    if (this.authClient.hasSession()) {
      new Notice(
        `Signed in as ${this.settings.accountEmail ?? 'unknown'}. ` +
          'Use the "Sign in / out" command to sign out.',
      );
    } else {
      new LoginModal(this.app, this, () => void this.onSignedIn()).open();
    }
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
      await this.saveSettings();
      this.setStatus('offline');
      this.refreshSettingsTab();
      new Notice('Signed out.');
    } else {
      new LoginModal(this.app, this, () => void this.onSignedIn()).open();
    }
  }

  /** Runs after a successful interactive sign-in. */
  private async onSignedIn(): Promise<void> {
    this.setStatus('online');
    this.refreshSettingsTab();
    if (!this.settings.initialSyncDone) {
      new InitialSyncModal(this.app, this).open();
    } else {
      await this.syncEngine.start();
    }
    void this.promptEncryption();
  }

  /**
   * Ensure end-to-end encryption is set up and unlocked on this device. Opens a
   * passphrase modal when needed; structure sync works regardless, but note
   * content can only be decrypted once unlocked.
   */
  async promptEncryption(): Promise<void> {
    if (!this.authClient.hasSession()) return;
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
  }

  /** Rejected-edit feedback, throttled so held-down keys don't stack notices. */
  private noticeReadOnly(path: string): void {
    const now = Date.now();
    if (now - this.lastReadOnlyNoticeAt < 2000) return;
    this.lastReadOnlyNoticeAt = now;
    new Notice(`“${path}” is read-only — you don't have edit permission.`);
  }

  setStatus(state: SyncStatus): void {
    this.syncState = state;
    this.renderStatusBar();
  }

  setE2eeState(s: 'unknown' | 'not-setup' | 'locked' | 'unlocked'): void {
    this.e2eeState = s;
    this.renderStatusBar();
  }

  /** Record a successful sync and refresh the status bar. */
  markSynced(): void {
    this.lastSyncedAt = Date.now();
    this.renderStatusBar();
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent =
      '@keyframes oc-spin{to{transform:rotate(360deg)}}' +
      '.oc-statusbar-item{display:inline-flex;align-items:center;gap:5px}' +
      '.oc-statusbar-item svg{width:13px;height:13px}' +
      '.oc-spin{animation:oc-spin 1s linear infinite;display:inline-flex}';
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  private renderStatusBar(): void {
    const el = this.statusBar;
    if (!el) return;
    el.empty();
    el.addClass('oc-statusbar-item');

    // Sync indicator: spinner while syncing, otherwise a coloured dot.
    const sync = el.createSpan();
    if (this.syncState === 'syncing') {
      setIcon(sync, 'refresh-cw');
      sync.addClass('oc-spin');
      sync.style.color = 'var(--text-accent)';
    } else {
      const dot = sync.createSpan({ text: '●' });
      dot.style.color =
        this.syncState === 'online'
          ? 'var(--color-green)'
          : this.syncState === 'error'
            ? 'var(--color-red)'
            : 'var(--text-faint)';
    }
    el.createSpan({ text: this.syncState === 'offline' ? 'Cloud offline' : 'Cloud' });

    // Last synchronised time.
    if (this.lastSyncedAt && this.syncState !== 'offline') {
      const t = new Date(this.lastSyncedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      el.createSpan({ text: `· ${t}` }).style.color = 'var(--text-faint)';
    }

    // E2EE indicator: green lock when active (unlocked), red when not.
    if (this.e2eeState !== 'unknown') {
      el.createSpan({ text: '·' }).style.color = 'var(--text-faint)';
      const lock = el.createSpan();
      const active = this.e2eeState === 'unlocked';
      setIcon(lock, active ? 'unlock' : 'lock');
      lock.style.color = active ? 'var(--color-green)' : 'var(--color-red)';
    }

    const lastTxt = this.lastSyncedAt ? new Date(this.lastSyncedAt).toLocaleString() : 'never';
    const e2eeTxt = {
      unknown: '—',
      'not-setup': 'not set up',
      locked: 'locked',
      unlocked: 'on',
    }[this.e2eeState];
    el.setAttribute(
      'aria-label',
      `Obsidian Cloud: ${this.syncState}\nEncryption: ${e2eeTxt}\nLast synchronised: ${lastTxt}`,
    );
  }

  /** Cloud menu (status-bar / ribbon click): sync, encryption, settings, sign in/out. */
  showMenu(evt: MouseEvent): void {
    const menu = new Menu();
    if (!this.authClient.hasSession()) {
      menu.addItem((i) => i.setTitle('Sign in').setIcon('log-in').onClick(() => void this.toggleAuth()));
    } else {
      menu.addItem((i) =>
        i.setTitle('Sync now').setIcon('refresh-cw').onClick(() => void this.syncEngine.syncNow()),
      );
      if (this.e2ee.unlocked) {
        menu.addItem((i) =>
          i.setTitle('Lock encryption').setIcon('lock').onClick(() => {
            this.e2ee.lock();
            this.setE2eeState('locked');
            new Notice('Encryption locked.');
          }),
        );
      } else {
        menu.addItem((i) =>
          i.setTitle('Set up / unlock encryption').setIcon('key').onClick(() => void this.promptEncryption()),
        );
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('Settings').setIcon('settings').onClick(() => this.openSettings()));
      menu.addItem((i) => i.setTitle('Sign out').setIcon('log-out').onClick(() => void this.toggleAuth()));
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
    // Clone the defaults: arrays/objects from DEFAULT_SETTINGS must never be
    // shared (and later mutated) across loads.
    this.settings = Object.assign({}, structuredClone(DEFAULT_SETTINGS), await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
