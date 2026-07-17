import { Notice } from 'obsidian';
import { hasCapability, type BlobContentDto, type GranteeKeyDto, type TreeNodeDto } from '@oc/shared';
import type ObsidianCloudPlugin from '../main';
import type { TreeApi } from '../api/TreeApi';
import { HttpError } from '../api/HttpClient';
import { askUser } from './Prompts';

/** The files that make up a distributable plugin. data.json (per-user
 *  settings, may contain secrets) is deliberately never synced. */
const SYNCED_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;

/** Plugin ids become filesystem paths — restrict to safe characters. */
const SAFE_ID = /^[\w.-]+$/;

/** Hex SHA-256 of the bytes, used to skip re-uploading unchanged plugin files
 *  on every reconcile. */
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Synchronises the server's central plugin folder (the system node with
 * systemType 'plugins') into this vault's `.obsidian/plugins/`.
 *
 *  - Pull (read access): download + decrypt main.js / manifest.json /
 *    styles.css per managed plugin, write them when they differ, and make
 *    sure the plugin is in community-plugins.json (enabled after a reload).
 *  - Push ('create'/'edit' on the folder): the "publish" command uploads a
 *    local plugin into the central folder.
 *
 * The subtree never materializes in the vault itself — SyncEngine excludes it
 * from the regular reconcile and hands the raw nodes to `run()`.
 */
export class PluginSyncer {
  /** nodeId → updatedAt already applied locally (skips unchanged downloads
   *  on every poll; cleared with the plugin instance). */
  private readonly applied = new Map<string, string>();
  /** `${id}/${fname}` → SHA-256 of the bytes last pushed to the server, so the
   *  automatic manager push skips files that haven't changed since. */
  private readonly pushed = new Map<string, string>();
  /** Signature of the last "reload Obsidian" notice, to show it once. */
  private lastEnableNotice = '';

  constructor(
    private readonly plugin: ObsidianCloudPlugin,
    private readonly tree: TreeApi,
  ) {}

  private get configDir(): string {
    return this.plugin.app.vault.configDir;
  }

  // ── pull: server → .obsidian/plugins ─────────────────────────────────────
  async run(nodes: TreeNodeDto[]): Promise<void> {
    const root = nodes.find((n) => n.systemType === 'plugins');
    if (!root || !this.plugin.e2ee.unlocked) return;
    // Only participants (consumers with read, or managers) receive the managed
    // plugins. An admin who was never granted the folder holds the keys (admins
    // can read all files) but is not a plugin participant, so don't install into
    // their vault.
    if (!hasCapability(root.capabilities, 'read')) return;
    const childrenOf = (parentId: string): TreeNodeDto[] =>
      nodes.filter((n) => n.parentId === parentId);

    // Managers push their local plugins up FIRST, before the pull. Otherwise a
    // freshly rebuilt local plugin would be overwritten by the older central
    // copy on restart (the pull-vs-local byte compare has no "mine is newer"),
    // then re-uploaded as the current version — losing the new build.
    const isManager =
      hasCapability(root.capabilities, 'create') || hasCapability(root.capabilities, 'edit');
    if (isManager) await this.pushLocal(nodes, root);

    const adapter = this.plugin.app.vault.adapter;
    const enable: string[] = [];
    for (const folder of childrenOf(root.id)) {
      if (folder.kind !== 'folder') continue;
      const id = await this.plugin.e2ee.tryDecryptName(folder.docId, folder.name);
      if (!id || !SAFE_ID.test(id)) continue; // no key shared yet / unsafe id
      const dir = `${this.configDir}/plugins/${id}`;
      for (const f of childrenOf(folder.id)) {
        if (f.kind !== 'file' || !f.docId) continue;
        const fname = await this.plugin.e2ee.tryDecryptName(f.docId, f.name);
        if (!fname || !(SYNCED_FILES as readonly string[]).includes(fname)) continue;
        await this.pullFile(f, `${dir}/${fname}`, `${id}/${fname}`);
      }
      // Only enable plugins that are actually complete on disk.
      if ((await adapter.exists(`${dir}/main.js`)) && (await adapter.exists(`${dir}/manifest.json`))) {
        enable.push(id);
      }
    }
    await this.ensureEnabled(enable);
  }

  /**
   * Upload every complete local plugin into the central folder. Runs each
   * reconcile for users who may manage the folder; only files whose contents
   * changed since the last push are re-uploaded. data.json is never included.
   */
  private async pushLocal(nodes: TreeNodeDto[], root: TreeNodeDto): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const pluginsDir = `${this.configDir}/plugins`;
    if (!(await adapter.exists(pluginsDir))) return;

    const listing = await adapter.list(pluginsDir);
    const ids = listing.folders
      .map((f) => f.split('/').pop() ?? '')
      // Skip unsafe ids and this plugin itself (never self-distribute).
      .filter((id) => SAFE_ID.test(id) && id !== this.plugin.manifest.id)
      .sort();

    // A sibling folder whose name we cannot decrypt might be another manager's
    // copy of a plugin we're about to push — creating a second folder with the
    // same plaintext id would duplicate it on every reconcile. When any sibling
    // is undecryptable, only push into folders we can already resolve.
    const hasOpaqueSibling = await this.hasUndecryptableChildFolder(nodes, root);

    let total = 0;
    const names: string[] = [];
    for (const id of ids) {
      const dir = `${pluginsDir}/${id}`;
      // Only distribute complete, valid plugins. Validating manifest.json also
      // rejects a truncated file caught mid-build (a partial read won't parse),
      // so half-written output is never distributed and auto-enabled fleet-wide.
      if (!(await this.isPublishablePlugin(dir, id))) continue;
      try {
        const n = await this.pushOne(id, nodes, root, true, hasOpaqueSibling);
        if (n > 0) {
          total += n;
          names.push(id);
        }
      } catch (err) {
        this.plugin.syncEngine.log.error(`↑ plugin ${id} push failed: ${(err as Error).message}`);
      }
    }
    if (total > 0) {
      this.plugin.syncEngine.log.success(
        `↑ auto-synced ${names.length} plugin(s): ${names.join(', ')} (${total} file(s))`,
      );
    }

    // Ensure EVERY user holds the keys for the plugin subtree (it is
    // auto-distributed to all). pushOne only keys newly-created files; this
    // covers existing files for users who joined since — gated by the user set.
    await this.ensureGranteesKeyed(nodes, root);
  }

  /** Distribute the plugin subtree's content keys to all current users (so a
   *  newly-joined user can decrypt the managed plugins). Runs only when the
   *  user set changed since the last distribution. */
  private async ensureGranteesKeyed(nodes: TreeNodeDto[], root: TreeNodeDto): Promise<void> {
    if (!root.docId) return;
    let grantees: GranteeKeyDto[];
    try {
      grantees = await this.plugin.http.get<GranteeKeyDto[]>(`/e2ee/grantees/${root.docId}`);
    } catch {
      return;
    }
    const signature = grantees
      .map((g) => `${g.userId}:${g.publicKey.slice(-24)}`)
      .sort()
      .join('|');
    if (grantees.length === 0 || signature === this.plugin.settings.pluginGranteeSignature) return;

    const prefix = `${root.path}/`;
    const subtree = nodes.filter(
      (n) => n.docId && (n.id === root.id || n.path.startsWith(prefix)),
    );
    for (const n of subtree) {
      try {
        await this.plugin.e2ee.keyDocFor(n.docId!, grantees);
      } catch {
        /* skip this node; retried on the next user-set change */
      }
    }
    this.plugin.settings.pluginGranteeSignature = signature;
    await this.plugin.saveSettings();
    this.plugin.syncEngine.log.info(`↑ distributed plugin keys to ${grantees.length} user(s)`);
  }

  /** True when the folder has a complete plugin whose manifest.json parses and
   *  its `id` matches the folder name (guards against mid-build/garbage). */
  private async isPublishablePlugin(dir: string, id: string): Promise<boolean> {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(`${dir}/main.js`)) || !(await adapter.exists(`${dir}/manifest.json`))) {
      return false;
    }
    try {
      const manifest: unknown = JSON.parse(await adapter.read(`${dir}/manifest.json`));
      return (
        typeof manifest === 'object' &&
        manifest !== null &&
        (manifest as { id?: unknown }).id === id
      );
    } catch {
      return false; // unparseable / partially written
    }
  }

  /** Whether any of the central folder's child folders has a name we can't
   *  decrypt (another manager's plugin, not shared with us). */
  private async hasUndecryptableChildFolder(nodes: TreeNodeDto[], root: TreeNodeDto): Promise<boolean> {
    for (const c of nodes) {
      if (c.parentId !== root.id || c.kind !== 'folder') continue;
      if ((await this.plugin.e2ee.tryDecryptName(c.docId, c.name)) === null) return true;
    }
    return false;
  }

  /** Download + decrypt one managed file; write only on a real difference. */
  private async pullFile(node: TreeNodeDto, target: string, label: string): Promise<void> {
    if (!node.docId || this.applied.get(node.id) === node.updatedAt) return;
    let blob: BlobContentDto;
    try {
      blob = await this.plugin.http.get<BlobContentDto>(`/documents/${node.docId}/blob`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return; // not uploaded yet
      throw err;
    }
    const bytes = await this.plugin.e2ee.decryptBlob(node.docId, blob.contentBase64);
    if (!bytes) return; // no key for this file (yet)

    const adapter = this.plugin.app.vault.adapter;
    if (await adapter.exists(target)) {
      const current = new Uint8Array(await adapter.readBinary(target));
      if (current.byteLength === bytes.byteLength && current.every((b, i) => b === bytes[i])) {
        this.applied.set(node.id, node.updatedAt);
        return;
      }
    }
    await this.ensureDir(target.slice(0, target.lastIndexOf('/')));
    await adapter.writeBinary(target, bytes.slice().buffer as ArrayBuffer);
    this.applied.set(node.id, node.updatedAt);
    this.plugin.syncEngine.log.info(`↓ plugin file ${label}`);
  }

  private async ensureDir(dir: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const parts = dir.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await adapter.exists(cur))) {
        await adapter.mkdir(cur).catch(() => undefined); // concurrent create — fine
      }
    }
  }

  /** Centrally managed plugins are auto-enabled: merge their ids into
   *  community-plugins.json (never removing anything the user enabled). */
  private async ensureEnabled(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const adapter = this.plugin.app.vault.adapter;
    const path = `${this.configDir}/community-plugins.json`;
    let enabled: string[] = [];
    if (await adapter.exists(path)) {
      try {
        const parsed: unknown = JSON.parse(await adapter.read(path));
        if (!Array.isArray(parsed)) return; // unexpected shape — don't rewrite it
        enabled = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        // Momentarily unreadable (e.g. racing Obsidian's own write). Bailing is
        // mandatory: rewriting from just the managed ids would DISABLE every
        // other community plugin the user has enabled.
        return;
      }
    }
    const missing = ids.filter((id) => !enabled.includes(id));
    if (missing.length === 0) return;
    await adapter.write(path, JSON.stringify([...enabled, ...missing], null, 2));
    const signature = missing.join(',');
    if (signature !== this.lastEnableNotice) {
      this.lastEnableNotice = signature;
      new Notice(
        `Obsidian Cloud installed managed plugin(s): ${missing.join(', ')}. ` +
          'Reload Obsidian to activate them.',
      );
    }
  }

  // ── push: publish a local plugin to the central folder ───────────────────
  async publish(): Promise<void> {
    const plugin = this.plugin;
    if (!plugin.authClient.hasSession()) {
      new Notice('Sign in first.');
      return;
    }
    if (!plugin.e2ee.unlocked) {
      new Notice('Unlock encryption first.');
      return;
    }
    const nodes = (await this.tree.getTree()).nodes;
    const root = nodes.find((n) => n.systemType === 'plugins');
    if (!root) {
      new Notice('There is no central plugin folder yet — an admin creates it in the web app.');
      return;
    }
    if (!hasCapability(root.capabilities, 'create') && !hasCapability(root.capabilities, 'edit')) {
      new Notice('You do not have permission to publish plugins.');
      return;
    }

    const adapter = plugin.app.vault.adapter;
    const pluginsDir = `${this.configDir}/plugins`;
    if (!(await adapter.exists(pluginsDir))) {
      new Notice('No local plugins found.');
      return;
    }
    const listing = await adapter.list(pluginsDir);
    const ids = listing.folders
      .map((f) => f.split('/').pop() ?? '')
      .filter((id) => SAFE_ID.test(id))
      .sort();
    if (ids.length === 0) {
      new Notice('No local plugins found.');
      return;
    }

    const choice = await askUser<string>(plugin.app, {
      title: 'Publish plugin',
      message:
        'Which local plugin should be published to the central folder?\n\n' +
        'Only main.js, manifest.json and styles.css are uploaded — settings (data.json) stay local.',
      options: ids.map((id) => ({ key: id, label: id })),
    });
    if (!choice) return;
    try {
      const published = await this.pushOne(choice, nodes, root, false);
      new Notice(
        `Published “${choice}” (${published} file(s)). ` +
          'Share the central plugin folder in the web app so teammates receive the keys.',
      );
      plugin.syncEngine.log.success(`↑ published plugin ${choice} (${published} file(s))`);
    } catch (err) {
      new Notice(`Publishing failed: ${(err as Error).message}`);
    }
  }

  /**
   * Upload one local plugin's synced files (main.js/manifest.json/styles.css)
   * into the central folder, creating the folder/file nodes as needed. Returns
   * the number of files actually uploaded. With `skipUnchanged`, files whose
   * bytes match the last push in this session are skipped.
   */
  private async pushOne(
    id: string,
    nodes: TreeNodeDto[],
    root: TreeNodeDto,
    skipUnchanged: boolean,
    hasOpaqueSibling = false,
  ): Promise<number> {
    const plugin = this.plugin;
    const adapter = plugin.app.vault.adapter;
    const dir = `${this.configDir}/plugins/${id}`;

    // Find (by decrypted name) or create the plugin's folder node.
    let folderId: string | null = null;
    for (const c of nodes) {
      if (c.parentId !== root.id || c.kind !== 'folder') continue;
      if ((await plugin.e2ee.tryDecryptName(c.docId, c.name)) === id) {
        folderId = c.id;
        break;
      }
    }
    if (!folderId) {
      // If some sibling folder is opaque to us, it may already be this plugin
      // (keyed for another manager). Creating a new folder would duplicate it
      // forever, so defer instead — the auto-push retries next reconcile.
      if (hasOpaqueSibling) {
        this.plugin.syncEngine.log.info(
          `↑ deferring plugin ${id}: a central folder is not shared with you yet.`,
        );
        return 0;
      }
      const { encryptedName, contentKey } = await plugin.e2ee.prepareName(id);
      const created = await this.tree.createNode({
        parentId: root.id,
        kind: 'folder',
        name: encryptedName,
      });
      if (created.docId) {
        await plugin.e2ee.storeContentKey(created.docId, contentKey);
        // Key the new subfolder name for the central folder's viewers.
        await plugin.e2ee.keyForGrantees(created.docId, contentKey).catch(() => undefined);
      }
      folderId = created.id;
    }

    let published = 0;
    for (const fname of SYNCED_FILES) {
      const local = `${dir}/${fname}`;
      if (!(await adapter.exists(local))) continue;
      const bytes = new Uint8Array(await adapter.readBinary(local));
      const sigKey = `${id}/${fname}`;
      const sig = await hashBytes(bytes);
      // Automatic push: skip files unchanged since the last upload this session.
      if (skipUnchanged && this.pushed.get(sigKey) === sig) continue;

      let docId: string | null = null;
      for (const c of nodes) {
        if (c.parentId !== folderId || c.kind !== 'file') continue;
        if ((await plugin.e2ee.tryDecryptName(c.docId, c.name)) === fname) {
          docId = c.docId;
          break;
        }
      }
      if (!docId) {
        const { encryptedName, contentKey } = await plugin.e2ee.prepareName(fname);
        const created = await this.tree.createNode({
          parentId: folderId,
          kind: 'file',
          name: encryptedName,
          isText: false,
        });
        if (created.docId) {
          await plugin.e2ee.storeContentKey(created.docId, contentKey);
          // Key the new plugin file for everyone the central folder is shared
          // with, so viewers receive it without the folder being re-shared.
          await plugin.e2ee.keyForGrantees(created.docId, contentKey).catch(() => undefined);
        }
        docId = created.docId;
      }
      if (!docId) continue;

      const contentBase64 = await plugin.e2ee.encryptBlob(docId, bytes);
      if (!contentBase64) throw new Error(`no encryption key for ${fname}`);
      await plugin.http.put(`/documents/${docId}/blob`, { contentBase64 });
      this.pushed.set(sigKey, sig);
      published++;
    }
    return published;
  }
}
