import { MAX_BLOB_BYTES, hasCapability, type TreeNodeDto } from '@oc/shared';
import type ObsidianCloudPlugin from '../main';
import type { TreeApi } from '../api/TreeApi';
import { isSyncedConfigFile } from './vaultScope';
import { canWriteVault } from './VaultPicker';
import { HttpError } from '../api/HttpClient';
import { t } from '../i18n';

/** Name of the config folder inside a server vault. Canonical regardless of
 *  the local `configDir` (which a user may have renamed). */
export const SERVER_CONFIG_DIR = '.obsidian';

const MIME: Record<string, string> = {
  json: 'application/json',
  js: 'text/javascript',
  css: 'text/css',
};

function mimeFor(name: string): string | undefined {
  return MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
}

/**
 * One-way push of this vault's Obsidian configuration (enabled plugins and
 * their code + settings, appearance, themes, snippets) into the server vault's
 * `.obsidian` folder, so the web app can render the vault like the desktop
 * does. Desktop is the source of truth; nothing is ever pulled back or deleted.
 *
 * That folder is server-protected (systemType 'config'): plugin code in it
 * runs in the browser of everyone who opens the vault, so only admins and
 * plugin admins may change it. For everyone else the push is skipped.
 *
 * Unchanged files are skipped via `configPushed` (path → docId:mtime:size),
 * persisted per device, so restarts don't re-upload megabytes of plugin code.
 */
export class ConfigSyncer {
  private readonly tooLargeNoted = new Set<string>();
  /** The server refused to set up / protect the config folder for this user
   *  (not a plugin admin) — don't retry every poll. */
  private denied = false;
  /** Pushed (or verified up to date) at least once this session. */
  private pushedOnce = false;

  /** For the settings: has this device's config reached the server? */
  get state(): 'pending' | 'ok' | 'denied' {
    return this.denied ? 'denied' : this.pushedOnce ? 'ok' : 'pending';
  }

  constructor(
    private readonly plugin: ObsidianCloudPlugin,
    private readonly tree: TreeApi,
  ) {}

  private get configDir(): string {
    return this.plugin.app.vault.configDir;
  }

  /**
   * @param nodes    the full tree (for the vault's capabilities)
   * @param existing server config nodes by vault-relative path ('.obsidian/…')
   * Returns the number of files uploaded.
   */
  async run(vaultId: string, nodes: TreeNodeDto[], existing: Map<string, TreeNodeDto>): Promise<number> {
    if (this.denied || !canWriteVault(nodes, vaultId)) return 0;
    const root = existing.get(SERVER_CONFIG_DIR);
    if (root?.systemType === 'config') {
      // Protected: only admins / plugin admins hold write capabilities in it.
      if (!hasCapability(root.capabilities, 'create') && !hasCapability(root.capabilities, 'edit')) {
        this.denied = true;
        return 0;
      }
    } else if (root) {
      // A `.obsidian` from before protection existed: protect it first (the
      // server only lets admins / plugin admins do that).
      try {
        const updated = await this.tree.updateNode(root.id, { systemType: 'config' });
        existing.set(SERVER_CONFIG_DIR, updated);
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) this.deny(err);
        else this.plugin.syncEngine.log.error(`Config push: ${(err as Error).message}`);
        return 0;
      }
    }
    const files = await this.listLocal();
    const settings = this.plugin.settings;
    const known = new Map(existing);
    let uploaded = 0;
    for (const rel of files) {
      if (this.denied) break;
      try {
        const stat = await this.plugin.app.vault.adapter.stat(`${this.configDir}/${rel}`);
        if (!stat || stat.type !== 'file') continue;
        if (stat.size > MAX_BLOB_BYTES) {
          if (!this.tooLargeNoted.has(rel)) {
            this.tooLargeNoted.add(rel);
            this.plugin.syncEngine.log.info(`Config file ${rel} is too large to sync — skipped.`);
          }
          continue;
        }
        const serverPath = `${SERVER_CONFIG_DIR}/${rel}`;
        const sig = `${stat.mtime}:${stat.size}`;
        const node = known.get(serverPath);
        if (node?.docId && settings.configPushed[rel] === `${node.docId}:${sig}`) continue;

        const docId = node?.docId ?? (await this.createFile(vaultId, serverPath, known));
        const bytes = new Uint8Array(await this.plugin.app.vault.adapter.readBinary(`${this.configDir}/${rel}`));
        const contentBase64 = await this.plugin.e2ee.encryptBlob(docId, bytes);
        if (!contentBase64) throw new Error('encryption key unavailable');
        await this.plugin.http.put(`/documents/${docId}/blob`, { contentBase64, mime: mimeFor(rel) });
        settings.configPushed[rel] = `${docId}:${sig}`;
        uploaded++;
      } catch (err) {
        if (this.denied) break;
        this.plugin.syncEngine.log.error(`Config push failed for ${rel}: ${(err as Error).message}`);
      }
    }
    if (!this.denied) this.pushedOnce = true;
    if (uploaded > 0) {
      await this.plugin.saveSettings();
      this.plugin.syncEngine.log.success(t('log.config', { n: uploaded }));
    }
    return uploaded;
  }

  private deny(err: unknown): void {
    this.denied = true;
    this.plugin.syncEngine.log.info(`${t('settings.config.denied')} (${(err as Error).message})`);
  }

  /** Every config file eligible for the push, relative to the config dir.
   *  Recurses only where eligible files can live (plugins/<id>, themes, snippets). */
  private async listLocal(): Promise<string[]> {
    const adapter = this.plugin.app.vault.adapter;
    const base = this.configDir;
    if (!(await adapter.exists(base))) return [];
    const out: string[] = [];
    const ownId = this.plugin.manifest.id;
    const walk = async (dir: string, depth: number, top: string | null): Promise<void> => {
      const listing = await adapter.list(dir);
      for (const f of listing.files) {
        const rel = f.slice(base.length + 1);
        if (isSyncedConfigFile(rel, ownId)) out.push(rel);
      }
      for (const sub of listing.folders) {
        const name = sub.slice(sub.lastIndexOf('/') + 1);
        if (top === null) {
          if (['plugins', 'themes', 'snippets'].includes(name)) await walk(sub, 1, name);
          continue;
        }
        // plugins/<id>/ only (never our own folder, never deeper).
        if (top === 'plugins' && (depth >= 2 || name === ownId)) continue;
        await walk(sub, depth + 1, top);
      }
    };
    await walk(base, 0, null);
    return out.sort();
  }

  /** Create the file node at `serverPath` (and any missing folders), keyed for
   *  this user and the vault's grantees. Returns its docId. */
  private async createFile(vaultId: string, serverPath: string, known: Map<string, TreeNodeDto>): Promise<string> {
    const segs = serverPath.split('/');
    let parentId = vaultId;
    for (let i = 0; i < segs.length; i++) {
      const path = segs.slice(0, i + 1).join('/');
      const isFile = i === segs.length - 1;
      const found = known.get(path);
      if (found) {
        parentId = found.id;
        continue;
      }
      const { encryptedName, contentKey } = await this.plugin.e2ee.prepareName(segs[i]);
      let created: TreeNodeDto;
      try {
        created = await this.tree.createNode({
          parentId,
          kind: isFile ? 'file' : 'folder',
          name: encryptedName,
          isText: isFile ? false : undefined,
          mime: isFile ? mimeFor(segs[i]) : undefined,
          // The vault's `.obsidian` itself is the protected config folder.
          systemType: i === 0 ? 'config' : undefined,
        });
      } catch (err) {
        if (i === 0 && err instanceof HttpError && err.status === 403) this.deny(err);
        throw err;
      }
      if (!created.docId) throw new Error('server returned no document id');
      try {
        await this.plugin.e2ee.storeContentKey(created.docId, contentKey);
      } catch (err) {
        await this.tree.deleteNode(created.id).catch(() => undefined);
        throw err;
      }
      await this.plugin.e2ee.keyForGrantees(created.docId, contentKey).catch(() => undefined);
      known.set(path, created);
      parentId = created.id;
      if (isFile) return created.docId;
    }
    const last = known.get(serverPath);
    if (!last?.docId) throw new Error(`no node for ${serverPath}`);
    return last.docId;
  }
}
