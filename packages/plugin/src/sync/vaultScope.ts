/**
 * Which server nodes a client mirrors into its local vault. Pure (no Obsidian
 * imports) so it can be unit-tested.
 *
 * The server tree holds several vaults: top-level folders flagged `isVault`.
 * A desktop vault syncs exactly one of them; paths are relative to that vault
 * node. Paths on the server are id-chains, so a top-level vault's path is its
 * own id and its descendants' paths start with `${vaultId}/` — the subtree can
 * be selected even when the vault node itself is not visible (only a subfolder
 * was shared with the user).
 */

export interface ScopeNode {
  id: string;
  parentId: string | null;
  path: string;
  isVault?: boolean;
  systemType?: string | null;
}

export interface VaultScope<T> {
  /** The nodes to mirror (the vault node itself is never included). */
  nodes: T[];
  /** Parent id for top-level local items (vault id; null = shared root). */
  rootParentId: string | null;
  /** False when the chosen vault is neither visible nor any of its contents. */
  found: boolean;
}

function inSubtree(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

/**
 * Select the nodes to sync.
 *  - Vault mode (`vaultId` set): only that vault's descendants.
 *  - Legacy mode (null): the shared root's content WITHOUT system folders and
 *    WITHOUT any vault subtree — a legacy client must never pull every vault
 *    into one local vault.
 */
export function selectVaultScope<T extends ScopeNode>(all: T[], vaultId: string | null): VaultScope<T> {
  if (vaultId) {
    const vault = all.find((n) => n.id === vaultId);
    const rootPath = vault?.path ?? vaultId;
    const nodes = all.filter((n) => n.path.startsWith(`${rootPath}/`));
    return { nodes, rootParentId: vaultId, found: !!vault || nodes.length > 0 };
  }
  const excluded = all.filter((n) => n.systemType || n.isVault).map((n) => n.path);
  const nodes = all.filter((n) => !excluded.some((p) => inSubtree(n.path, p)));
  return { nodes, rootParentId: null, found: true };
}

/** Whether a vault-relative path is (inside) a config folder like `.obsidian`.
 *  Those never materialize as vault files — the config syncs separately. */
export function isConfigPath(path: string, configDirs: readonly string[]): boolean {
  return configDirs.some((d) => d !== '' && inSubtree(path, d));
}

/** Plugin ids become filesystem paths — restrict to safe characters. */
const SAFE_ID = /^[\w.-]+$/;
const PLUGIN_FILES = new Set(['main.js', 'manifest.json', 'styles.css', 'data.json']);

/**
 * Which files of the local config folder (path relative to it, '/'-separated)
 * are pushed to the vault's `.obsidian` folder on the server:
 *  - top-level `*.json`, except the per-device `workspace*.json` layouts;
 *  - `plugins/<id>/{main.js,manifest.json,styles.css,data.json}`, except this
 *    plugin itself (its data.json holds account state);
 *  - everything under `themes/` and `snippets/`.
 */
export function isSyncedConfigFile(rel: string, ownPluginId: string): boolean {
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (segs.length === 1) return /\.json$/i.test(rel) && !/^workspace/i.test(rel);
  const [top, ...rest] = segs;
  if (top === 'plugins') {
    if (rest.length !== 2) return false;
    const [id, file] = rest;
    return SAFE_ID.test(id) && id !== ownPluginId && PLUGIN_FILES.has(file);
  }
  return top === 'themes' || top === 'snippets';
}
