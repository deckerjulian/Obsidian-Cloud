import { t } from '../i18n';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { EncryptedProvider } from '@oc/shared/yjs-provider';
import { Notice, type TFile } from 'obsidian';
import { WS_DOC_PATH, YTEXT_FIELD, type DocumentBootstrapDto } from '@oc/shared';
import type ObsidianCloudPlugin from '../main';
import { VaultBridge, type ContentConflict, type ConflictChoice } from './VaultBridge';

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
}

function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash}, 68%, 45%)`;
}

export interface DocSessionCallbacks {
  /** Ask how to resolve a both-sides-changed conflict. */
  resolveConflict: (conflict: ContentConflict) => Promise<ConflictChoice>;
  /** The user deferred the conflict — the owner should close this session so
   *  reopening the file asks again. */
  onDeferred: () => void;
  /** Initial seeding finished; the two-way bridge is live. */
  onSeeded?: () => void;
  onError?: (message: string) => void;
}

/** One live, end-to-end-encrypted collaborative session for a single file. */
export class DocSession {
  readonly ydoc: Y.Doc;
  private provider: EncryptedProvider | null = null;
  private awareness: Awareness | null = null;
  private readonly idb: IndexeddbPersistence;
  private readonly bridge: VaultBridge;
  private readOnly = false;
  private destroyed = false;
  private seeded = false;
  /** Y.Text content after local persistence loaded but before server updates —
   *  the base for the bridge's 3-way seed decision. */
  private preSyncText = '';

  constructor(
    private readonly plugin: ObsidianCloudPlugin,
    private file: TFile,
    readonly docId: string,
    private readonly callbacks: DocSessionCallbacks,
  ) {
    this.ydoc = new Y.Doc();
    this.idb = new IndexeddbPersistence(`oc-${docId}`, this.ydoc);
    this.bridge = new VaultBridge(
      plugin.app.vault,
      file,
      this.ydoc,
      () => this.readOnly,
      (conflict) => this.callbacks.resolveConflict(conflict),
    );
  }

  /** Returns false when the session could not start (bootstrap failed, no
   *  content key) — the owner must close it so a later open can retry. */
  async start(): Promise<boolean> {
    try {
      const boot = await this.plugin.http.get<DocumentBootstrapDto>(
        `/documents/${this.docId}/bootstrap`,
      );
      this.readOnly = !boot.writable;
    } catch (err) {
      // A transient failure (server hiccup, offline) must NOT degrade to a
      // read-only session: read-only seeds always PULL, which would silently
      // overwrite local offline edits with the server state. Abort instead —
      // no session means no pushes and no pulls until a later open succeeds.
      this.callbacks.onError?.(
        `Could not open “${this.file.path}”: ${(err as Error).message}`,
      );
      return false;
    }

    // The content key is unwrapped locally; without it we can't decrypt.
    const contentKey = await this.plugin.e2ee.getContentKey(this.docId);
    if (!contentKey) {
      new Notice(
        this.plugin.e2ee.unlocked
          ? t('notice.noKey', { path: this.file.path })
          : t('notice.unlockToOpen', { path: this.file.path }),
      );
      return false;
    }

    // Local persisted state must be loaded BEFORE we look at the doc, and the
    // server log must be replayed before any seed decision — otherwise a fresh
    // device would push the whole file as new ops and duplicate the note.
    await this.idb.whenSynced;
    if (this.destroyed) return false;
    this.preSyncText = this.ydoc.getText(YTEXT_FIELD).toString();

    this.awareness = new Awareness(this.ydoc);
    // Note: no onStatus wiring — individual sessions flapping their WS must
    // not flip the global status bar; the reconcile poll owns that signal.
    this.provider = new EncryptedProvider({
      url: `${toWsUrl(this.plugin.settings.serverUrl)}${WS_DOC_PATH}`,
      docId: this.docId,
      doc: this.ydoc,
      contentKey,
      awareness: this.awareness,
      getToken: async () => {
        // WS reconnects have no 401-retry path — refresh an expired token
        // here, or the provider would retry with the stale one forever.
        if (!this.plugin.tokenStore.isAccessTokenValid()) {
          await this.plugin.authClient.refresh();
        }
        return this.plugin.tokenStore.getAccessToken();
      },
      onSynced: () => void this.handleSynced(),
      canCompact: () => !this.readOnly,
    });

    // Publish cursor identity for collaborators.
    const name = this.plugin.settings.accountEmail ?? 'Obsidian user';
    this.awareness.setLocalStateField('user', {
      name,
      color: colorForUser(name),
      colorLight: colorForUser(name).replace('45%)', '85%)'),
    });

    if (this.readOnly) {
      new Notice(t('notice.viewer', { path: this.file.path }));
    }
    return true;
  }

  /** Whether the first server sync arrived (seeding started or done). Owners
   *  use this to distinguish "still connecting" from "waiting on the user". */
  get syncStarted(): boolean {
    return this.seeded;
  }

  /** First server sync of this session: run the (possibly interactive) seed. */
  private async handleSynced(): Promise<void> {
    if (this.seeded || this.destroyed) return;
    this.seeded = true;
    try {
      const active = await this.bridge.start(this.preSyncText);
      if (this.destroyed) return;
      if (!active) {
        this.callbacks.onDeferred();
        return;
      }
      this.callbacks.onSeeded?.();
    } catch (err) {
      this.callbacks.onError?.(`Could not seed “${this.file.path}”: ${(err as Error).message}`);
    }
  }

  onFileModified(file: TFile): void {
    this.file = file;
    this.bridge.onFileModified(file);
  }

  /** Capability change from the tree poll (edit revoked or granted while the
   *  session is open). The bridge reads the flag through a callback, so it
   *  takes effect immediately; only announce the restrictive transition. */
  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    if (readOnly) new Notice(t('notice.revoked', { path: this.file.path }));
  }

  destroy(): void {
    this.destroyed = true;
    this.bridge.destroy();
    this.provider?.destroy();
    this.awareness?.destroy();
    void this.idb.destroy();
    this.ydoc.destroy();
  }
}
