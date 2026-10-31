import { MarkdownView, Notice, TFile, TFolder, type TAbstractFile, normalizePath } from 'obsidian';
import {
  parentPath,
  basename,
  depthOf,
  hasCapability,
  isTextFileName,
  MAX_BLOB_BYTES,
  type BlobContentDto,
  type NodeKind,
  type TreeNodeDto,
  type UpdateNodeRequest,
} from '@oc/shared';
import type ObsidianCloudPlugin from '../main';
import { TreeApi } from '../api/TreeApi';
import { HttpError } from '../api/HttpClient';
import { DocSession } from './DocSession';
import { ConfigSyncer, SERVER_CONFIG_DIR } from './ConfigSync';
import { isConfigPath, selectVaultScope } from './vaultScope';
import { SyncLog, summarizeReport, type SyncReport } from './SyncLog';
import { askUser, PromptQueue, type PromptOption } from './Prompts';
import { t } from '../i18n';
import type { ContentConflict, ConflictChoice } from './VaultBridge';

interface KnownNode {
  id: string;
  docId: string | null;
  kind: NodeKind;
  isText: boolean;
  /** Server-side 'edit' capability — gates local editing of this file. */
  canEdit: boolean;
}

type PushKind = 'create' | 'rename' | 'delete' | 'upload';

/**
 * Two-way synchronisation between the local vault and the server.
 *  - Pull: reconcile() mirrors the server tree into the vault (folders, notes,
 *    encrypted binary attachments).
 *  - Push: reconcile() uploads local-only files; handleCreate/Delete/Rename
 *    forward live structure changes to the server.
 *  - Live: per-note DocSession bridges content over Yjs.
 * Echo between the two directions is prevented with a consume-once ignore set
 * plus the knownNodes map (a path that's already synced is never re-pushed).
 *
 * Anything that cannot be synchronized surfaces as a modal asking the user how
 * to proceed (retry / decide later / never sync), serialized via PromptQueue.
 */
export class SyncEngine {
  readonly tree: TreeApi;
  readonly log = new SyncLog();
  readonly configSync: ConfigSyncer;
  private syncing = false;
  private readonly sessions = new Map<string, DocSession>(); // docId -> session
  private readonly knownNodes = new Map<string, KnownNode>(); // path -> node
  private readonly ignorePaths = new Set<string>();
  private pollTimer: number | null = null;
  /** Becomes true after the first reconcile, so we never mistake the initial
   *  vault load for user-created files to push. */
  private ready = false;
  /**
   * Serializes reconcile runs and live vault-event handlers. They share
   * `knownNodes`/`trackedPaths`/`docIds`; interleaving them mid-flight caused
   * duplicate server nodes, resurrected deletions and root-moved children
   * (reconcile clears and rebuilds `knownNodes` across many awaits).
   */
  private opChain: Promise<unknown> = Promise.resolve();

  private readonly prompts = new PromptQueue();
  /** Issue keys currently showing a modal (avoid duplicates). */
  private readonly pendingIssues = new Set<string>();
  /** Issue keys the user answered "later" — muted until the next manual sync. */
  private readonly mutedIssues = new Set<string>();
  /** Last reconcile error signature already shown to the user. */
  private lastIssueSignature = '';
  /** Attachments known to have no server content yet (log once). */
  private readonly emptyBlobsNoted = new Set<string>();
  /** Last reconcile's name-decrypt failure count (log only on change, not
   *  every 20-second poll). */
  private lastDecryptFailures = 0;
  private readonly blobUploadTimers = new Map<string, number>();
  private readonly textSeedTimers = new Map<string, number>();
  /** Serialized content seeding for files pushed during reconcile. */
  private seedChain: Promise<void> = Promise.resolve();
  /** Whether the "key all my docs for admins" backfill ran this session. */
  private adminBackfillDone = false;
  /** Parent id for top-level vault items: the chosen vault node, or null for
   *  the shared root (legacy mode). Set by every reconcile. */
  private rootParentId: string | null = null;
  /** The "choose a vault" prompt was offered this session (don't nag on every poll). */
  private vaultPrompted = false;
  /** Last "vault unavailable" message already logged. */
  private lastScopeError = '';

  /** ETag + node cache for the tree poll (304 → reuse last response). */
  private treeEtag: string | null = null;
  private cachedNodes: TreeNodeDto[] | null = null;
  /** Server paths of the previous reconcile (node id → path), to detect
   *  server-side renames/moves and mirror them as local renames. */
  private prevServerPaths: Map<string, string> | null = null;
  /** Live sessions are evicted LRU beyond this bound (open files are kept). */
  private static readonly MAX_LIVE_SESSIONS = 12;
  private readonly sessionUsed = new Map<string, number>(); // docId → last activity

  constructor(private readonly plugin: ObsidianCloudPlugin) {
    this.tree = new TreeApi(plugin.http);
    this.configSync = new ConfigSyncer(plugin, this.tree);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async start(): Promise<SyncReport | null> {
    const report = await this.runReconcile(true);
    const active = this.plugin.app.workspace.getActiveFile();
    if (active) void this.openFile(active);
    this.startPolling();
    return report;
  }

  stop(): void {
    this.stopPolling();
    this.destroyAll();
    // Cached tree state must not leak into another account's session: a stale
    // knownNodes map (or ready=true) would let vault events push against the
    // previous account, and a stale tree would mass-trash local files.
    this.treeEtag = null;
    this.cachedNodes = null;
    this.prevServerPaths = null;
    this.knownNodes.clear();
    this.ready = false;
    this.adminBackfillDone = false;
    this.rootParentId = null;
    this.vaultPrompted = false;
  }

  /** Run `fn` after every queued reconcile/vault-event handler has finished. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.catch(() => undefined);
    return run;
  }

  startPolling(): void {
    this.stopPolling();
    const secs = Math.max(5, this.plugin.settings.syncIntervalSeconds || 20);
    this.pollTimer = window.setInterval(() => void this.runReconcile(false), secs * 1000);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Run a reconcile. `verbose` reports the result to the log/notice/status. */
  async runReconcile(verbose: boolean): Promise<SyncReport | null> {
    if (this.syncing || !this.plugin.authClient.hasSession()) return null;
    this.syncing = true;
    if (verbose) this.plugin.setStatus('syncing');
    try {
      const report = await this.runExclusive(() => this.reconcile());
      this.plugin.setStatus('online');
      this.plugin.markSynced();
      if (verbose) this.log.success(`${t('initial.done')} — ${summarizeReport(report)}`);
      this.maybePromptReconcileIssues(report);
      return report;
    } catch (err) {
      const message = (err as Error).message;
      // No HTTP answer (network down, DNS, refused) or a gateway error means
      // the server is unreachable — "offline", not a sync problem.
      const offline = !(err instanceof HttpError) || err.status >= 502;
      this.plugin.setStatus(offline ? 'offline' : 'error', message);
      this.log.error(`${t('status.error')}: ${message}`);
      if (verbose) new Notice(t('notice.syncFailed', { msg: message }));
      return null;
    } finally {
      this.syncing = false;
    }
  }

  syncNow(): Promise<SyncReport | null> {
    // A manual sync resets "decide later" mutes so open problems ask again.
    this.mutedIssues.clear();
    this.lastIssueSignature = '';
    return this.runReconcile(true);
  }

  /**
   * Reconstruct each server node's plaintext path by decrypting names along the
   * parent chain (the server only knows id-paths). Nodes whose names cannot be
   * decrypted (missing key, network failure) are counted and skipped — treating
   * ciphertext as a real name would create garbage files locally and make
   * previously synced paths look server-deleted.
   */
  private async buildServerPaths(
    nodes: TreeNodeDto[],
  ): Promise<{ paths: Map<string, string>; failures: number }> {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const nameCache = new Map<string, string | null>();
    const nameOf = async (n: TreeNodeDto): Promise<string | null> => {
      const cached = nameCache.get(n.id);
      if (cached !== undefined) return cached;
      const name = await this.plugin.e2ee.tryDecryptName(n.docId, n.name);
      nameCache.set(n.id, name);
      return name;
    };
    const paths = new Map<string, string>();
    let failures = 0;
    for (const n of nodes) {
      if (n.path === '') continue;
      const segs: string[] = [];
      let cur: TreeNodeDto | undefined = n;
      let ok = true;
      while (cur && cur.path !== '') {
        const name = await nameOf(cur);
        if (name === null || name === '') {
          ok = false;
          break;
        }
        segs.unshift(name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      if (!ok) {
        failures++;
        continue;
      }
      paths.set(n.id, normalizePath(segs.join('/')));
    }
    return { paths, failures };
  }

  // ── reconcile: pull, delete, push ─────────────────────────────────────────
  private async reconcile(): Promise<SyncReport> {
    const report: SyncReport = {
      foldersCreated: 0,
      filesCreated: 0,
      pushed: 0,
      removed: 0,
      errors: [],
    };
    // Conditional fetch: on 304 the last tree is reused — the local phases
    // (repair, push-scan) still run, but the server skips the per-user ACL
    // walk and the payload. A 304 without a cache (shouldn't happen) must
    // never be treated as an empty tree: refetch unconditionally instead.
    const cached = await this.tree.getTreeCached(this.cachedNodes ? this.treeEtag : null);
    let nodes: TreeNodeDto[];
    if (cached.notModified && this.cachedNodes) {
      nodes = this.cachedNodes;
    } else {
      nodes = (cached.tree ?? (await this.tree.getTree())).nodes;
      this.cachedNodes = nodes;
      this.treeEtag = cached.etag;
    }
    const vault = this.plugin.app.vault;

    // Names are encrypted; without the keys we cannot map server nodes to vault
    // paths. Structure sync therefore requires encryption to be unlocked.
    if (!this.plugin.e2ee.unlocked) {
      this.log.info(`${t('status.locked')} — ${t('status.locked.detail')}`);
      this.ready = false;
      return report;
    }
    // One bulk request instead of one key fetch per node.
    await this.plugin.e2ee.primeKeyCache();

    const settings = this.plugin.settings;
    const settingsSnapshot = JSON.stringify([settings.trackedPaths, settings.docIds]);
    const oldTracked = new Set(settings.trackedPaths.map((p) => normalizePath(p)));
    // The initial sync (until the first full reconcile completes) is a pure
    // merge: pull everything, push local-only files, and delete NOTHING on
    // either side. A file missing locally is pulled from the server, never
    // interpreted as a deletion — so a fresh device never wipes the server.
    const initialSync = !settings.initialSyncDone;

    // Which server subtree this local vault mirrors. Nothing syncs until the
    // user picked a vault (or explicitly the legacy shared root): a fresh
    // install must never pull whatever happens to sit at the server root.
    if (!settings.vaultId && !settings.legacyRoot) {
      this.log.info(t('status.noVault.detail'));
      this.ready = false;
      if (!this.vaultPrompted) {
        this.vaultPrompted = true;
        void this.plugin.promptVaultChoice(false);
      }
      return report;
    }
    // In legacy mode (no vault chosen) vault subtrees are excluded.
    const scope = selectVaultScope(nodes, settings.vaultId);
    if (!scope.found) {
      // Deleted, or access revoked. Treating the empty result as "everything
      // was deleted on the server" would trash the whole local vault.
      const msg = t('sync.vaultGone', { vault: settings.vaultName ?? settings.vaultId ?? '' });
      report.errors.push(msg);
      // The poll repeats every few seconds; log once per distinct situation.
      if (msg !== this.lastScopeError) this.log.error(msg);
      this.lastScopeError = msg;
      this.ready = false;
      return report;
    }
    this.lastScopeError = '';
    this.rootParentId = scope.rootParentId;

    const { paths: allPaths, failures: decryptFailures } = await this.buildServerPaths(scope.nodes);
    // The vault's config folder (.obsidian) syncs separately (ConfigSyncer):
    // never pulled into the vault, never mistaken for deletions.
    const configDirs = [SERVER_CONFIG_DIR, vault.configDir];
    // The server-protected config folder (systemType 'config') is the one the
    // config push targets; any other `.obsidian` is ignored but never pulled.
    const protectedRoot = scope.nodes.find((n) => n.systemType === 'config' && n.parentId === settings.vaultId);
    const configNodes = new Map<string, TreeNodeDto>();
    const configIds = new Set<string>();
    for (const n of scope.nodes) {
      const p = allPaths.get(n.id);
      if (p !== undefined && isConfigPath(p, configDirs)) {
        configIds.add(n.id);
        const inProtected = !protectedRoot || n.id === protectedRoot.id || n.path.startsWith(`${protectedRoot.path}/`);
        if (inProtected) configNodes.set(p, n);
      }
    }
    const vaultNodes = configIds.size > 0 ? scope.nodes.filter((n) => !configIds.has(n.id)) : scope.nodes;
    const serverPaths =
      configIds.size > 0 ? new Map([...allPaths].filter(([id]) => !configIds.has(id))) : allPaths;
    if (decryptFailures > 0) {
      const msg = t('sync.undecryptable', { n: decryptFailures });
      report.errors.push(msg);
      // The poll repeats every few seconds; only log when the situation changes.
      if (decryptFailures !== this.lastDecryptFailures) this.log.error(msg);
    }
    this.lastDecryptFailures = decryptFailures;

    // Server-side renames/moves: the same node id under a new path becomes a
    // local rename (keeps backlinks and editor state) instead of the delete +
    // empty-recreate the path diff would otherwise produce.
    if (this.prevServerPaths) {
      const renames = [...serverPaths.entries()]
        .map(([id, newPath]) => ({ newPath, oldPath: this.prevServerPaths!.get(id) }))
        .filter((r): r is { newPath: string; oldPath: string } => !!r.oldPath && r.oldPath !== r.newPath)
        .sort((a, b) => depthOf(a.newPath) - depthOf(b.newPath)); // parents first
      for (const { oldPath, newPath } of renames) {
        const af = vault.getAbstractFileByPath(oldPath);
        if (!af || vault.getAbstractFileByPath(newPath)) continue; // moved with parent / target taken
        try {
          await this.ensureFolder(parentPath(newPath));
          this.ignoreOnce(oldPath);
          this.ignoreOnce(newPath);
          await this.plugin.app.fileManager.renameFile(af, newPath);
          this.log.info(t('log.moved', { from: oldPath, to: newPath }));
        } catch (err) {
          // The rename didn't happen — its consume-once markers must not
          // survive to swallow a later, real user rename of these paths.
          this.ignorePaths.delete(normalizePath(oldPath));
          this.ignorePaths.delete(normalizePath(newPath));
          const msg = `Could not move ${oldPath} → ${newPath}: ${(err as Error).message}`;
          report.errors.push(msg);
          this.log.error(msg);
        }
      }
    }
    this.prevServerPaths = serverPaths;

    // Rebuild the known-node map and the path → docId map for sessions.
    this.knownNodes.clear();
    const docIds: Record<string, string> = {};
    for (const n of vaultNodes) {
      const path = serverPaths.get(n.id);
      if (!path) continue;
      this.knownNodes.set(path, {
        id: n.id,
        docId: n.docId,
        kind: n.kind,
        isText: n.isText,
        canEdit: hasCapability(n.capabilities, 'edit'),
      });
      if (n.kind === 'file' && n.docId && n.isText) docIds[path] = n.docId;
    }
    // On a clean run the maps are replaced (so server deletions drop out). On
    // a failure run they are merged: a name that failed to decrypt this round
    // must not lose its docId (live sync would stop) or leave trackedPaths
    // (the file would be re-uploaded later, resurrecting a server deletion).
    settings.docIds = decryptFailures === 0 ? docIds : { ...settings.docIds, ...docIds };
    const desiredPaths = new Set<string>(this.knownNodes.keys());

    // Live permission propagation: an already-open session's read-only flag
    // follows the tree capabilities, so revoking 'edit' takes effect without
    // the user having to close and reopen the file.
    for (const node of this.knownNodes.values()) {
      if (!node.docId) continue;
      this.sessions.get(node.docId)?.setReadOnly(!node.canEdit);
    }

    // Offline local deletions: a FILE we tracked last session that still exists
    // on the server but is now missing from the vault was deleted while we
    // weren't watching (Obsidian closed, e2ee locked, external file manager).
    // Propagate the deletion instead of letting the pull phase resurrect it.
    // Gated on layoutReady so an un-indexed file is never mistaken for one that
    // was deleted; folders are excluded (Obsidian prunes empty folders, which
    // would look like deletions); skipped on any decrypt failure; and NEVER on
    // the initial sync (a fresh device has none of the files yet — pull them).
    const deletedOfflineIds = new Set<string>();
    // Safety against a wiped/moved vault with stale trackedPaths: if NONE of the
    // previously-synced paths are present locally, this isn't "the user deleted
    // files" — it's a reset device. Pull instead of deleting the whole server.
    const anyTrackedPresent = [...oldTracked].some((p) => vault.getAbstractFileByPath(p));
    const mayDelete = this.plugin.layoutReady && decryptFailures === 0 && !initialSync && anyTrackedPresent;
    if (mayDelete) {
      const deletedOffline = [...this.knownNodes.entries()].filter(
        ([path, node]) =>
          node.kind === 'file' &&
          oldTracked.has(path) &&
          !this.isIgnored(path) &&
          !vault.getAbstractFileByPath(path),
      );
      for (const [path, node] of deletedOffline) {
        try {
          await this.tree.deleteNode(node.id);
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404)) {
            const msg = `Could not delete ${path} (removed locally): ${(err as Error).message}`;
            report.errors.push(msg);
            this.log.error(msg);
            continue;
          }
        }
        this.knownNodes.delete(path);
        desiredPaths.delete(path);
        if (node.docId) {
          this.closeSession(node.docId);
          try {
            indexedDB.deleteDatabase(`oc-${node.docId}`);
          } catch {
            /* best-effort */
          }
          delete settings.docIds[path];
        }
        deletedOfflineIds.add(node.id);
        report.removed++;
        this.log.info(t('log.deletedOffline', { path }));
      }
    }

    // Pull: create folders, notes and attachments, shallowest first.
    const ordered = vaultNodes.filter((n) => n.path !== '').sort((a, b) => a.depth - b.depth);
    for (const node of ordered) {
      if (deletedOfflineIds.has(node.id)) continue; // just deleted on the server
      const path = serverPaths.get(node.id);
      if (!path) continue;
      const existing = vault.getAbstractFileByPath(path);
      try {
        if (node.kind === 'folder') {
          if (!(existing instanceof TFolder)) {
            await this.ensureFolder(path);
            report.foldersCreated++;
            this.log.info(t('log.downFolder', { path }));
          }
        } else if (!(existing instanceof TFile)) {
          if (node.isText) {
            await this.ensureFolder(parentPath(path));
            this.ignoreOnce(path);
            await vault.create(path, '');
            report.filesCreated++;
            this.log.info(t('log.downNote', { path }));
          } else {
            // Binary attachment: download + decrypt (no empty placeholders).
            await this.downloadBlobToVault(node, path, report);
          }
        }
      } catch (err) {
        const msg = `Could not create ${path}: ${(err as Error).message}`;
        report.errors.push(msg);
        this.log.error(msg);
      }
    }

    // Remove local paths we previously synced that the server has since deleted.
    // Skipped entirely when any name failed to decrypt — a transient key problem
    // must never look like a server-side deletion — and on the initial sync,
    // which only ever pulls and pushes (never deletes).
    if (decryptFailures === 0 && !initialSync) {
      for (const tracked of oldTracked) {
        if (desiredPaths.has(tracked) || this.isIgnored(tracked)) continue;
        const af = vault.getAbstractFileByPath(tracked);
        if (!af) continue;
        try {
          this.ignoreOnce(tracked);
          await vault.trash(af, false);
          report.removed++;
          this.log.info(t('log.removed', { path: tracked }));
        } catch (err) {
          // Failed trash: drop the marker, or it would eat the user's next
          // real deletion of this path (leaving the server node alive).
          this.ignorePaths.delete(normalizePath(tracked));
          const msg = `Could not remove ${tracked}: ${(err as Error).message}`;
          report.errors.push(msg);
          this.log.error(msg);
        }
      }
    }

    settings.trackedPaths =
      decryptFailures === 0 ? [...desiredPaths] : [...new Set([...oldTracked, ...desiredPaths])];

    // Push: upload local files/folders the server doesn't know yet (created
    // while logged out, while Obsidian was closed, or whose earlier push
    // failed). Previously tracked paths are deletion candidates, not new files.
    if (decryptFailures === 0) {
      const locals = vault
        .getAllLoadedFiles()
        .filter((f) => {
          const p = normalizePath(f.path);
          // getAllLoadedFiles() includes the vault root folder as '/'; pushing
          // it would create a nameless node on the server.
          return (
            p !== '' &&
            p !== '/' &&
            !this.knownNodes.has(p) &&
            !oldTracked.has(p) &&
            !this.isIgnored(p)
          );
        })
        .sort((a, b) => depthOf(normalizePath(a.path)) - depthOf(normalizePath(b.path)));

      const failedParents = new Set<string>();
      for (const af of locals) {
        const p = normalizePath(af.path);
        const parent = parentPath(p);
        if (parent !== '' && (failedParents.has(parent) || !this.knownNodes.has(parent))) {
          failedParents.add(p);
          continue;
        }
        try {
          await this.pushLocalNode(af);
          report.pushed++;
          const node = this.knownNodes.get(p);
          if (af instanceof TFile && node?.docId && node.isText) {
            this.queueContentSeed(p, node.docId);
          }
        } catch (err) {
          failedParents.add(p);
          const msg = `Could not upload ${p}: ${(err as Error).message}`;
          report.errors.push(msg);
          this.log.error(msg);
        }
      }
    }

    // The first CLEAN full reconcile (unlocked, all names decryptable)
    // establishes the baseline; from now on missing-local files are treated as
    // deletions, not pulled. Set here — not prematurely on sign-in — so a
    // locked, failed or partial first attempt stays a safe merge.
    const baselineEstablished = initialSync && decryptFailures === 0;
    if (baselineEstablished) settings.initialSyncDone = true;

    if (
      JSON.stringify([settings.trackedPaths, settings.docIds]) !== settingsSnapshot ||
      baselineEstablished
    ) {
      await this.plugin.saveSettings();
    }

    // This vault's .obsidian → the server vault's config folder (one-way), so
    // the web app runs the same plugins/settings. Only on clean runs: an
    // undecryptable config node could otherwise be duplicated.
    if (settings.vaultId && decryptFailures === 0) {
      try {
        await this.configSync.run(settings.vaultId, nodes, configNodes);
      } catch (err) {
        this.log.error(`Config sync failed: ${(err as Error).message}`);
      }
    }

    // Ensure admins hold keys for the docs this user can decrypt (admins read
    // all files). Once per session unless the admin set changed; only after a
    // clean run so we never key ciphertext we couldn't verify.
    if (decryptFailures === 0 && !this.adminBackfillDone) {
      this.adminBackfillDone = true;
      const prev = settings.adminKeySignature;
      try {
        const sig = await this.plugin.e2ee.backfillAdminKeys(prev);
        if (sig !== prev) {
          settings.adminKeySignature = sig;
          await this.plugin.saveSettings();
          this.log.info('Shared document keys with admins.');
        }
      } catch (err) {
        this.log.error(`Admin key backfill failed: ${(err as Error).message}`);
      }
    }

    this.ready = true;
    return report;
  }

  /** Create a folder and any missing ancestors (mkdir -p), avoiding the
   *  "folder not indexed yet" race that makes child-note creation fail. */
  private async ensureFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    if (p === '') return;
    if (this.plugin.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    const parent = parentPath(p);
    if (parent) await this.ensureFolder(parent);
    if (this.plugin.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    this.ignoreOnce(p);
    try {
      await this.plugin.app.vault.createFolder(p);
    } catch {
      /* concurrent create — fine */
    }
  }

  // ── binary attachments ─────────────────────────────────────────────────────
  private async downloadBlobToVault(
    node: TreeNodeDto,
    path: string,
    report: SyncReport,
  ): Promise<void> {
    if (!node.docId) return;
    try {
      const blob = await this.plugin.http.get<BlobContentDto>(`/documents/${node.docId}/blob`);
      const bytes = await this.plugin.e2ee.decryptBlob(node.docId, blob.contentBase64);
      if (!bytes) return;
      await this.ensureFolder(parentPath(path));
      this.ignoreOnce(path);
      await this.plugin.app.vault.createBinary(path, bytes.slice().buffer as ArrayBuffer);
      report.filesCreated++;
      this.log.info(t('log.downFile', { path }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Node exists but no content was uploaded yet — never create an empty
        // placeholder that would look like a corrupted attachment.
        if (!this.emptyBlobsNoted.has(node.docId)) {
          this.emptyBlobsNoted.add(node.docId);
          this.log.info(`Attachment ${path} has no content on the server yet.`);
        }
        return;
      }
      const msg = `Could not download ${path}: ${(err as Error).message}`;
      report.errors.push(msg);
      this.log.error(msg);
    }
  }

  private async uploadBlob(path: string, docId: string, file: TFile): Promise<void> {
    const data = new Uint8Array(await this.plugin.app.vault.readBinary(file));
    if (data.byteLength > MAX_BLOB_BYTES) {
      const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
      throw new Error(
        `attachment is ${mb(data.byteLength)} MB — above the ${mb(MAX_BLOB_BYTES)} MB sync limit`,
      );
    }
    const contentBase64 = await this.plugin.e2ee.encryptBlob(docId, data);
    if (!contentBase64) throw new Error('encryption key unavailable');
    await this.plugin.http.put(`/documents/${docId}/blob`, { contentBase64 });
    this.emptyBlobsNoted.delete(docId);
    this.log.success(t('log.upFile', { path }));
  }

  private scheduleBlobUpload(path: string, docId: string, file: TFile): void {
    const existing = this.blobUploadTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.blobUploadTimers.set(
      path,
      window.setTimeout(() => {
        this.blobUploadTimers.delete(path);
        void this.uploadBlob(path, docId, file).catch((err) =>
          this.promptPushIssue('upload', path, err as Error, () =>
            this.uploadBlob(path, docId, file),
          ),
        );
      }, 1500),
    );
  }

  // ── push: local -> server ─────────────────────────────────────────────────
  private ignoreOnce(path: string): void {
    this.ignorePaths.add(normalizePath(path));
  }
  private consumeIgnore(path: string): boolean {
    const p = normalizePath(path);
    if (this.ignorePaths.has(p)) {
      this.ignorePaths.delete(p);
      return true;
    }
    return false;
  }

  /** True when the user chose "never sync" for this path (or a folder above). */
  private isIgnored(path: string): boolean {
    return this.plugin.settings.ignoredPaths.some(
      (ig) => path === ig || path.startsWith(`${ig}/`),
    );
  }

  /** Create one local file/folder on the server: encrypted name, wrapped
   *  content key, and (for attachments) the encrypted blob. Throws on failure. */
  private async pushLocalNode(file: TAbstractFile): Promise<void> {
    const path = normalizePath(file.path);
    const kind: NodeKind = file instanceof TFolder ? 'folder' : 'file';
    const parent = parentPath(path);
    const parentId = parent === '' ? this.rootParentId : (this.knownNodes.get(parent)?.id ?? null);
    if (parent !== '' && parentId === null) throw new Error('parent folder is not synced yet');

    const fileName = basename(path);
    // An empty name would create a nameless node that no client can display
    // or map back to a path (it also poisons every future reconcile).
    if (!fileName.trim()) throw new Error('file name is empty');
    // The name is encrypted with a fresh content key (also used for content);
    // the key is then wrapped for this user. Requires encryption unlocked.
    const { encryptedName, contentKey } = await this.plugin.e2ee.prepareName(fileName);
    const created = await this.tree.createNode({
      parentId,
      kind,
      name: encryptedName,
      isText: kind === 'file' ? isTextFileName(fileName) : undefined,
    });
    if (created.docId) {
      try {
        await this.plugin.e2ee.storeContentKey(created.docId, contentKey);
      } catch (err) {
        // Without its key the node's name is undecryptable for EVERYONE, and
        // one such orphan pauses deletions/uploads on every client. Roll the
        // create back instead of leaving it behind.
        await this.tree.deleteNode(created.id).catch(() => undefined);
        throw err;
      }
      // Make it readable at once by anyone the parent folder is shared with.
      await this.plugin.e2ee.keyForGrantees(created.docId, contentKey).catch(() => undefined);
    }
    this.knownNodes.set(path, {
      id: created.id,
      docId: created.docId,
      kind,
      isText: created.isText,
      canEdit: hasCapability(created.capabilities, 'edit'),
    });
    if (!this.plugin.settings.trackedPaths.includes(path)) {
      this.plugin.settings.trackedPaths.push(path);
    }
    if (kind === 'file' && created.docId) {
      if (created.isText) {
        this.plugin.settings.docIds[path] = created.docId;
      } else if (file instanceof TFile) {
        await this.uploadBlob(path, created.docId, file);
      }
    }
    this.log.success(t('log.upCreated', { path }));
  }

  handleCreate(file: TAbstractFile): Promise<void> {
    return this.runExclusive(() => this.doHandleCreate(file));
  }

  private async doHandleCreate(file: TAbstractFile): Promise<void> {
    if (!this.ready || !this.plugin.authClient.hasSession()) return;
    const path = normalizePath(file.path);
    if (this.consumeIgnore(path)) return; // our own reconcile op
    if (this.knownNodes.has(path)) return; // already synced
    if (this.isIgnored(path)) return;
    if (!this.plugin.e2ee.unlocked) return; // reconcile pushes it after unlock

    const parent = parentPath(path);
    if (parent !== '' && !this.knownNodes.has(parent)) return; // reconcile push phase picks it up

    try {
      await this.pushLocalNode(file);
      await this.plugin.saveSettings();
      const node = this.knownNodes.get(path);
      if (file instanceof TFile && node?.docId && node.isText) void this.openFile(file);
    } catch (err) {
      // Idempotent retry: re-run a full reconcile rather than a bare re-push.
      // If the first createNode actually landed but its response was lost, the
      // reconcile sees the node in the tree and the push-scan skips it — no
      // duplicate. If it truly failed, the push-scan uploads it exactly once.
      this.promptPushIssue('create', path, err as Error, async () => {
        await this.runReconcile(false);
      });
    }
  }

  handleDelete(file: TAbstractFile): Promise<void> {
    return this.runExclusive(() => this.doHandleDelete(file));
  }

  private async doHandleDelete(file: TAbstractFile): Promise<void> {
    if (!this.ready || !this.plugin.authClient.hasSession()) return;
    const path = normalizePath(file.path);
    if (this.consumeIgnore(path)) return;
    const node = this.knownNodes.get(path);
    if (!node) return;
    try {
      await this.finishDelete(path, node);
    } catch (err) {
      this.promptPushIssue('delete', path, err as Error, () =>
        this.runExclusive(() => this.finishDelete(path, node)),
      );
    }
  }

  private async finishDelete(path: string, node: KnownNode): Promise<void> {
    try {
      await this.tree.deleteNode(node.id);
    } catch (err) {
      // Already gone server-side — just clean up locally.
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
    this.knownNodes.delete(path);
    this.plugin.settings.trackedPaths = this.plugin.settings.trackedPaths.filter((p) => p !== path);
    if (node.docId) {
      this.closeSession(node.docId);
      // The doc is gone — drop its Yjs IndexedDB cache so deleted notes don't
      // accumulate stale (decrypted) CRDT state forever.
      try {
        indexedDB.deleteDatabase(`oc-${node.docId}`);
      } catch {
        /* best-effort */
      }
      delete this.plugin.settings.docIds[path];
    }
    await this.plugin.saveSettings();
    this.log.success(t('log.upDeleted', { path }));
  }

  handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    return this.runExclusive(() => this.doHandleRename(file, oldPath));
  }

  private async doHandleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.ready || !this.plugin.authClient.hasSession()) return;
    const newPath = normalizePath(file.path);
    const old = normalizePath(oldPath);
    // Consume BOTH markers before deciding (|| would leave a stale entry that
    // swallows a later, real event for that path).
    const ignoredNew = this.consumeIgnore(newPath);
    const ignoredOld = this.consumeIgnore(old);
    if (ignoredNew || ignoredOld) return;
    const node = this.knownNodes.get(old);
    if (!node) {
      // A folder rename fires one event per descendant too. Handlers are
      // serialized, so by the time a descendant's event runs, the folder's
      // own rename has already remapped the subtree — doHandleCreate then
      // sees the new path as known and no-ops.
      await this.doHandleCreate(file);
      return;
    }
    try {
      await this.finishRename(file, old, newPath, node);
    } catch (err) {
      this.promptPushIssue('rename', old, err as Error, () =>
        this.runExclusive(() => this.finishRename(file, old, newPath, node)),
      );
    }
  }

  private async finishRename(
    file: TAbstractFile,
    old: string,
    newPath: string,
    node: KnownNode,
  ): Promise<void> {
    const body: UpdateNodeRequest = {};
    if (basename(old) !== basename(newPath)) {
      // Encrypt the new name with the node's existing content key.
      const enc = node.docId
        ? await this.plugin.e2ee.encryptNameFor(node.docId, basename(newPath))
        : null;
      if (!enc) throw new Error('encryption locked or no key');
      body.name = enc;
    }
    const oldParent = parentPath(old);
    const newParent = parentPath(newPath);
    if (oldParent !== newParent) {
      if (newParent === '') {
        // Top level of the local vault = the vault node (null = shared root).
        body.parentId = this.rootParentId;
      } else {
        const parentNode = this.knownNodes.get(newParent);
        // NEVER fall back to null here: parentId null means "vault root" to
        // the server, so an unknown destination folder would scatter renamed
        // children across the root. Fail instead; reconcile/retry catches up.
        if (!parentNode) throw new Error('destination folder is not synced yet');
        body.parentId = parentNode.id;
      }
    }
    if (body.name === undefined && body.parentId === undefined) return;

    try {
      await this.tree.updateNode(node.id, body);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // Node vanished server-side — push the renamed file as a new one.
        this.knownNodes.delete(old);
        this.plugin.settings.trackedPaths = this.plugin.settings.trackedPaths.filter((p) => p !== old);
        delete this.plugin.settings.docIds[old];
        await this.pushLocalNode(file);
        await this.plugin.saveSettings();
        return;
      }
      throw err;
    }
    this.remapSubtree(old, newPath);
    await this.plugin.saveSettings();
    this.log.success(t('log.upRenamed', { from: old, to: newPath }));
  }

  private remapSubtree(oldPath: string, newPath: string): void {
    const moves: Array<[string, string]> = [];
    for (const key of this.knownNodes.keys()) {
      if (key === oldPath) moves.push([key, newPath]);
      else if (key.startsWith(`${oldPath}/`)) moves.push([key, `${newPath}${key.slice(oldPath.length)}`]);
    }
    for (const [from, to] of moves) {
      const node = this.knownNodes.get(from)!;
      this.knownNodes.delete(from);
      this.knownNodes.set(to, node);
      this.plugin.settings.trackedPaths = this.plugin.settings.trackedPaths.map((p) => (p === from ? to : p));
      if (this.plugin.settings.docIds[from]) {
        this.plugin.settings.docIds[to] = this.plugin.settings.docIds[from];
        delete this.plugin.settings.docIds[from];
      }
    }
  }

  // ── user prompts (how should sync problems be handled?) ──────────────────
  /** Ask how a both-sides-changed file should be resolved. */
  private async resolveContentConflict(conflict: ContentConflict): Promise<ConflictChoice> {
    if (!this.plugin.settings.askOnConflict) {
      this.log.info(`Conflict in ${conflict.path}: keeping both (automatic).`);
      return 'both';
    }
    const choice = await this.prompts.run(() =>
      askUser<'server' | 'local' | 'both'>(this.plugin.app, {
        title: t('conflict.title'),
        icon: 'git-merge|git-compare',
        message: t('conflict.message', { path: conflict.path }),
        options: [
          { key: 'both', label: t('conflict.both'), cta: true },
          { key: 'server', label: t('conflict.server') },
          { key: 'local', label: t('conflict.local') },
        ],
      }),
    );
    if (!choice) {
      this.log.info(`Conflict in ${conflict.path} deferred — file left untouched.`);
      return 'later';
    }
    this.log.info(`Conflict in ${conflict.path}: ${choice === 'both' ? 'kept both' : `${choice} version used`}.`);
    return choice;
  }

  /** Ask how a failed local→server operation should be handled. */
  private promptPushIssue(
    kind: PushKind,
    path: string,
    err: Error,
    retry: () => Promise<void>,
  ): void {
    const msg = `Could not sync “${path}”: ${err.message}`;
    this.log.error(msg);
    if (!this.plugin.settings.askOnConflict) {
      new Notice(t('notice.problem', { msg }));
      return;
    }
    const key = `${kind}:${path}`;
    if (this.pendingIssues.has(key) || this.mutedIssues.has(key) || this.isIgnored(path)) return;
    this.pendingIssues.add(key);

    void this.prompts.run(async () => {
      const options: Array<PromptOption<'retry' | 'later' | 'ignore'>> = [
        { key: 'retry', label: t('problem.retry'), cta: true },
        { key: 'later', label: t('problem.later') },
      ];
      if (kind === 'create' || kind === 'upload') {
        options.push({ key: 'ignore', label: t('problem.ignore'), warning: true });
      }
      const choice = await askUser(this.plugin.app, {
        title: t('problem.title'),
        message: t('problem.message', { path, msg: err.message }),
        options,
      });
      this.pendingIssues.delete(key);
      if (choice === 'retry') {
        try {
          await retry();
          this.log.success(`Retry succeeded: ${path}`);
        } catch (retryErr) {
          this.mutedIssues.add(key);
          const m = `Still failing for “${path}”: ${(retryErr as Error).message}`;
          this.log.error(m);
          new Notice(t('notice.problem', { msg: m }));
        }
      } else if (choice === 'ignore') {
        this.plugin.settings.ignoredPaths.push(path);
        await this.plugin.saveSettings();
        this.log.info(`Never syncing: ${path}`);
      } else {
        this.mutedIssues.add(key); // until the next manual sync
      }
    });
  }

  /** One aggregated popup per distinct set of reconcile errors. */
  private maybePromptReconcileIssues(report: SyncReport): void {
    if (report.errors.length === 0) {
      this.lastIssueSignature = '';
      return;
    }
    if (!this.plugin.settings.askOnConflict) return;
    const signature = report.errors.join('|');
    if (signature === this.lastIssueSignature) return; // already asked for exactly these
    this.lastIssueSignature = signature;

    void this.prompts.run(async () => {
      const details = report.errors.slice(0, 8);
      if (report.errors.length > 8) details.push(t('problems.more', { n: report.errors.length - 8 }));
      const choice = await askUser<'retry' | 'later'>(this.plugin.app, {
        title: t('problems.title'),
        message: t('problems.message', { n: report.errors.length }),
        details,
        options: [
          { key: 'retry', label: t('problems.retry'), cta: true },
          { key: 'later', label: t('action.notNow') },
        ],
      });
      if (choice === 'retry') void this.syncNow();
    });
  }

  // ── live content sessions ─────────────────────────────────────────────────
  async openFile(file: TFile): Promise<void> {
    if (!this.ready || !this.plugin.authClient.hasSession()) return;
    const path = normalizePath(file.path);
    const docId = this.plugin.settings.docIds[path];
    if (!docId) return;
    this.sessionUsed.set(docId, Date.now());
    if (this.sessions.has(docId)) return;
    const session = new DocSession(this.plugin, file, docId, {
      resolveConflict: (c) => this.resolveContentConflict(c),
      onDeferred: () => this.closeSession(docId), // reopening the file asks again
      onSeeded: () => this.log.info(t('log.live', { path })),
      onError: (m) => this.log.error(m),
    });
    this.sessions.set(docId, session);
    this.evictIdleSessions();
    try {
      // A session that could not start (no content key yet, bootstrap failed)
      // must not stay in the map — it would block every future open/modify of
      // this doc until restart, even after the key arrives.
      if (!(await session.start())) this.closeSession(docId);
    } catch (err) {
      this.closeSession(docId);
      this.log.error(`Could not open “${file.path}”: ${(err as Error).message}`);
    }
  }

  private closeSession(docId: string): void {
    this.sessionUsed.delete(docId);
    const session = this.sessions.get(docId);
    if (!session) return;
    this.sessions.delete(docId);
    session.destroy();
  }

  /** Bound resource usage: every session holds a WebSocket + IndexedDB. Keep
   *  files that are open in some pane; close the least recently used rest. */
  private evictIdleSessions(): void {
    if (this.sessions.size <= SyncEngine.MAX_LIVE_SESSIONS) return;
    const openPaths = new Set<string>();
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const f = leaf.view instanceof MarkdownView ? leaf.view.file : null;
      if (f) openPaths.add(normalizePath(f.path));
    }
    const pathByDoc = new Map(
      Object.entries(this.plugin.settings.docIds).map(([p, d]) => [d, p]),
    );
    const candidates = [...this.sessions.keys()]
      .filter((docId) => {
        const p = pathByDoc.get(docId);
        return !p || !openPaths.has(p);
      })
      .sort((a, b) => (this.sessionUsed.get(a) ?? 0) - (this.sessionUsed.get(b) ?? 0));
    for (const docId of candidates) {
      if (this.sessions.size <= SyncEngine.MAX_LIVE_SESSIONS) break;
      const p = pathByDoc.get(docId);
      this.closeSession(docId);
      this.log.info(`session closed (idle): ${p ?? docId}`);
    }
  }

  /** Seed the content of a file pushed during reconcile (open a short-lived
   *  session so the note body reaches the server without a manual file-open). */
  private queueContentSeed(path: string, docId: string): void {
    this.seedChain = this.seedChain
      .then(() => this.seedContent(path, docId))
      .catch(() => undefined);
  }

  private async seedContent(path: string, docId: string): Promise<void> {
    if (this.sessions.has(docId)) return;
    const af = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      // Timeout only covers "server never synced" (offline). Once seeding
      // started, completion comes from the callbacks — possibly after the
      // user answered a conflict modal, which must not be raced.
      const timer = window.setTimeout(() => {
        if (!session.syncStarted) finish();
      }, 20_000);
      const session = new DocSession(this.plugin, af, docId, {
        resolveConflict: (c) => this.resolveContentConflict(c),
        onDeferred: finish,
        onSeeded: finish,
        onError: (m) => {
          this.log.error(m);
          finish();
        },
      });
      this.sessions.set(docId, session);
      session
        .start()
        .then((ok) => {
          // Could not start (no key / bootstrap failed): drop the dead session
          // so a later open retries, and unblock the seed queue.
          if (!ok) {
            this.closeSession(docId);
            finish();
          }
        })
        .catch(() => {
          this.closeSession(docId);
          finish();
        });
    });
    // Keep the session only while the file is actively open.
    if (this.plugin.app.workspace.getActiveFile()?.path !== path) this.closeSession(docId);
  }

  /** Whether the local user may edit the file at `path`. Paths the server
   *  doesn't know (local-only, not yet synced, name-decrypt failed) are always
   *  editable — enforcement must never lock the user out of their own files. */
  canEditPath(path: string): boolean {
    return this.knownNodes.get(normalizePath(path))?.canEdit ?? true;
  }

  handleFileModified(file: TFile): void {
    // Persisted docIds from a previous session must not trigger doomed seed
    // sessions/uploads while signed out or before the first reconcile.
    if (!this.ready || !this.plugin.authClient.hasSession()) return;
    const path = normalizePath(file.path);
    const docId = this.plugin.settings.docIds[path];
    if (docId) {
      const session = this.sessions.get(docId);
      if (session) {
        this.sessionUsed.set(docId, Date.now());
        session.onFileModified(file);
      } else {
        // Modified without being opened (Templater, other plugins, external
        // editors): sync the content through a short-lived session.
        this.scheduleTextSeed(path, docId);
      }
      return;
    }
    // Binary attachments have no live session — re-upload the encrypted blob,
    // or restore the server version when the user has no edit permission.
    const node = this.knownNodes.get(path);
    if (node && node.kind === 'file' && !node.isText && node.docId) {
      if (node.canEdit) this.scheduleBlobUpload(path, node.docId, file);
      else this.scheduleBlobRevert(path, node.docId, file);
    }
  }

  /** Overwrite a locally changed read-only attachment with the server content. */
  private async revertBlob(path: string, docId: string, file: TFile): Promise<void> {
    let blob: BlobContentDto;
    try {
      blob = await this.plugin.http.get<BlobContentDto>(`/documents/${docId}/blob`);
    } catch (err) {
      // No server content to restore from — leave the local file alone.
      if (err instanceof HttpError && err.status === 404) return;
      throw err;
    }
    const bytes = await this.plugin.e2ee.decryptBlob(docId, blob.contentBase64);
    if (!bytes) return;
    // Only write on a real difference: the revert itself fires another
    // 'modify' event, and equality is what terminates that cycle.
    const current = new Uint8Array(await this.plugin.app.vault.readBinary(file));
    if (current.byteLength === bytes.byteLength && current.every((b, i) => b === bytes[i])) return;
    await this.plugin.app.vault.modifyBinary(file, bytes.slice().buffer as ArrayBuffer);
    this.log.info(t('log.reverted', { path }));
    new Notice(t('notice.reverted', { path }));
  }

  private scheduleBlobRevert(path: string, docId: string, file: TFile): void {
    const existing = this.blobUploadTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.blobUploadTimers.set(
      path,
      window.setTimeout(() => {
        this.blobUploadTimers.delete(path);
        void this.revertBlob(path, docId, file).catch((err) =>
          this.log.error(`Could not revert ${path}: ${(err as Error).message}`),
        );
      }, 1500),
    );
  }

  /** Debounced content sync for text files modified in the background. */
  private scheduleTextSeed(path: string, docId: string): void {
    const existing = this.textSeedTimers.get(path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.textSeedTimers.set(
      path,
      window.setTimeout(() => {
        this.textSeedTimers.delete(path);
        this.queueContentSeed(path, docId);
      }, 2000),
    );
  }

  /** After the encryption passphrase is entered, run the (previously skipped)
   * structure sync and rebuild sessions so the now-available keys take effect. */
  onEncryptionUnlocked(): void {
    void this.runReconcile(true).finally(() => {
      for (const session of this.sessions.values()) session.destroy();
      this.sessions.clear();
      const active = this.plugin.app.workspace.getActiveFile();
      if (active) void this.openFile(active);
    });
  }

  destroyAll(): void {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.sessionUsed.clear();
    for (const timer of this.blobUploadTimers.values()) window.clearTimeout(timer);
    this.blobUploadTimers.clear();
    for (const timer of this.textSeedTimers.values()) window.clearTimeout(timer);
    this.textSeedTimers.clear();
  }
}
