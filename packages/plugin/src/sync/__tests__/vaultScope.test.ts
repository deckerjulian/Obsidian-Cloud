import { describe, it, expect } from 'vitest';
import { isConfigPath, isSyncedConfigFile, selectVaultScope, type ScopeNode } from '../vaultScope';

// Id-paths: the root is '', a top-level node's path is its id.
const n = (id: string, path: string, extra: Partial<ScopeNode> = {}): ScopeNode => ({
  id,
  parentId: null,
  path,
  ...extra,
});
const tree: ScopeNode[] = [
  n('root', ''),
  n('legacyNote', 'legacyNote'),
  n('plugins', 'plugins', { systemType: 'config' }),
  n('pluginFile', 'plugins/pluginFile'),
  n('v1', 'v1', { isVault: true }),
  n('v1a', 'v1/v1a'),
  n('v1b', 'v1/v1a/v1b'),
  n('v2', 'v2', { isVault: true }),
  n('v2a', 'v2/v2a'),
];
const ids = (xs: ScopeNode[]): string[] => xs.map((x) => x.id).sort();

describe('selectVaultScope', () => {
  it('selects only the chosen vault subtree, without the vault node', () => {
    const s = selectVaultScope(tree, 'v1');
    expect(ids(s.nodes)).toEqual(['v1a', 'v1b']);
    expect(s.rootParentId).toBe('v1');
    expect(s.found).toBe(true);
  });

  it('works when only a subfolder of the vault is visible (shared subtree)', () => {
    const s = selectVaultScope(tree.filter((x) => x.id !== 'v1'), 'v1');
    expect(ids(s.nodes)).toEqual(['v1a', 'v1b']);
    expect(s.found).toBe(true);
  });

  it('reports a vanished vault instead of an empty (= "all deleted") scope', () => {
    const s = selectVaultScope(tree, 'gone');
    expect(s.found).toBe(false);
    expect(s.nodes).toEqual([]);
  });

  it('legacy mode excludes system folders and every vault', () => {
    const s = selectVaultScope(tree, null);
    expect(ids(s.nodes)).toEqual(['legacyNote', 'root']);
    expect(s.rootParentId).toBeNull();
  });
});

describe('isConfigPath', () => {
  it('matches the config folder and its contents only', () => {
    expect(isConfigPath('.obsidian', ['.obsidian'])).toBe(true);
    expect(isConfigPath('.obsidian/plugins/x/main.js', ['.obsidian'])).toBe(true);
    expect(isConfigPath('.obsidian-notes/a.md', ['.obsidian'])).toBe(false);
    expect(isConfigPath('notes/.obsidian/a', ['.obsidian'])).toBe(false);
    expect(isConfigPath('a.md', [''])).toBe(false);
  });
});

describe('isSyncedConfigFile', () => {
  const own = 'obsidian-cloud';
  it('takes top-level json except per-device workspace layouts', () => {
    expect(isSyncedConfigFile('app.json', own)).toBe(true);
    expect(isSyncedConfigFile('community-plugins.json', own)).toBe(true);
    expect(isSyncedConfigFile('workspace.json', own)).toBe(false);
    expect(isSyncedConfigFile('workspace-mobile.json', own)).toBe(false);
    expect(isSyncedConfigFile('notes.txt', own)).toBe(false);
  });

  it('takes plugin code + settings, never this plugin', () => {
    expect(isSyncedConfigFile('plugins/dataview/main.js', own)).toBe(true);
    expect(isSyncedConfigFile('plugins/dataview/data.json', own)).toBe(true);
    expect(isSyncedConfigFile('plugins/dataview/node_modules/x.js', own)).toBe(false);
    expect(isSyncedConfigFile('plugins/dataview/other.txt', own)).toBe(false);
    expect(isSyncedConfigFile('plugins/obsidian-cloud/main.js', own)).toBe(false);
    expect(isSyncedConfigFile('plugins/bad id/main.js', own)).toBe(false);
  });

  it('takes themes and snippets, rejects traversal', () => {
    expect(isSyncedConfigFile('themes/Minimal/theme.css', own)).toBe(true);
    expect(isSyncedConfigFile('snippets/a.css', own)).toBe(true);
    expect(isSyncedConfigFile('themes/../app.json', own)).toBe(false);
    expect(isSyncedConfigFile('cache/x', own)).toBe(false);
  });
});
