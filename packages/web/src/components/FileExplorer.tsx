import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNodeDto, NodeKind } from '@oc/shared';
import { hasCapability, isTextFileName } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useE2ee } from '../e2ee/E2eeContext';
import { treeApi } from '../api/endpoints';
import { AclPanel } from '../acl/AclPanel';
import { Icon } from './Icon';

interface TreeNode extends TreeNodeDto {
  children: TreeNode[];
}

function buildForest(
  nodes: TreeNodeDto[],
  names: Map<string, string>,
): { forest: TreeNode[]; root: TreeNodeDto | undefined } {
  const root = nodes.find((n) => n.path === '');
  const items = nodes.filter((n) => n.path !== '');
  const byId = new Map<string, TreeNode>(items.map((n) => [n.id, { ...n, children: [] }]));
  const forest: TreeNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else forest.push(n); // parent is the vault root or outside our access
  }
  const label = (n: TreeNode) => names.get(n.id) ?? n.name;
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : label(a).localeCompare(label(b)),
    );
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(forest);
  return { forest, root };
}

export function FileExplorer({
  selectedId,
  onOpen,
}: {
  selectedId: string | null;
  onOpen: (node: TreeNodeDto) => void;
}) {
  const { authFetch, treeFetch } = useAuth();
  const { status, prepareName, storeContentKey, keyForGrantees, encryptNameFor, decryptName } =
    useE2ee();
  const api = useMemo(() => treeApi(authFetch), [authFetch]);
  const [nodes, setNodes] = useState<TreeNodeDto[]>([]);
  const [displayNames, setDisplayNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [aclNode, setAclNode] = useState<TreeNodeDto | null>(null);
  const treeEtag = useRef<string | null>(null);

  // Conditional fetch (ETag/304): a 304 means the tree is unchanged, so we keep
  // the current nodes and don't re-render. `silent` swallows poll errors so a
  // transient failure doesn't flash the error banner.
  const reload = useCallback(
    async (silent = false) => {
      try {
        const res = await treeFetch(treeEtag.current);
        treeEtag.current = res.etag;
        if (!res.notModified && res.tree) setNodes(res.tree.nodes);
        if (!silent) setError(null);
      } catch (e) {
        if (!silent) setError((e as Error).message);
      }
    },
    [treeFetch],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll the tree so files created/renamed/deleted elsewhere (the Obsidian
  // plugin, another browser) appear automatically. Cheap thanks to ETag/304;
  // paused while the tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void reload(true);
    };
    const id = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload]);

  // Decrypt node names locally (the server only stores ciphertext).
  useEffect(() => {
    let active = true;
    void (async () => {
      const entries = await Promise.all(
        nodes.map(async (n) => [n.id, await decryptName(n.docId, n.name)] as const),
      );
      if (active) setDisplayNames(new Map(entries));
    })();
    return () => {
      active = false;
    };
    // `status` is included so names re-decrypt the moment encryption unlocks.
  }, [nodes, decryptName, status]);

  const nameOf = useCallback(
    (node: TreeNodeDto) => {
      // Empty display names (bad data or an undecryptable name) must still
      // produce a visible, clickable row — otherwise the node can't be deleted.
      const label = displayNames.get(node.id) ?? node.name;
      return label.trim() === '' ? '(unnamed)' : label;
    },
    [displayNames],
  );

  const { forest, root } = useMemo(
    () => buildForest(nodes, displayNames),
    [nodes, displayNames],
  );
  const rootCanCreate = root ? hasCapability(root.capabilities, 'create') : false;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const create = useCallback(
    async (parentId: string | null, kind: NodeKind) => {
      if (status !== 'unlocked') {
        window.alert('Unlock end-to-end encryption first (status bar, bottom) to create items.');
        return;
      }
      const input = window.prompt(`New ${kind} name`, kind === 'file' ? 'Untitled.md' : 'New folder');
      if (!input) return;
      let name = input.trim();
      if (!name) return; // whitespace-only input would create an unnamed node
      // Text notes must end in .md — enforced client-side now (the server can't read names).
      if (kind === 'file' && !/\.(md|markdown)$/i.test(name)) name = `${name}.md`;
      const isText = kind === 'file' ? isTextFileName(name) : undefined;
      try {
        // The name is encrypted with a fresh content key, which is then wrapped
        // for the creator. The same key encrypts the note's content + blobs.
        const { encryptedName, contentKey } = await prepareName(name);
        const created = await api.create({ parentId, kind, name: encryptedName, isText });
        if (created.docId) {
          try {
            await storeContentKey(created.docId, contentKey);
          } catch (keyErr) {
            // The content key lived only in memory; without it this node's name
            // is undecryptable for everyone (renders as "(unnamed)"/base64).
            // Roll the node back instead of leaving an orphan behind.
            await api.remove(created.id).catch(() => undefined);
            throw keyErr;
          }
          // Fan the key out to everyone who already has access to this folder,
          // so a note created in a shared folder is readable by them at once.
          await keyForGrantees(created.docId, contentKey).catch(() => undefined);
        }
        await reload();
      } catch (e) {
        window.alert((e as Error).message);
      }
    },
    [api, reload, status, prepareName, storeContentKey, keyForGrantees],
  );

  const rename = useCallback(
    async (node: TreeNodeDto) => {
      const current = nameOf(node);
      const input = window.prompt('Rename to', current);
      if (!input || input.trim() === current) return;
      let name = input.trim();
      if (!name) return; // whitespace-only input would create an unnamed node
      if (node.kind === 'file' && node.isText && !/\.(md|markdown)$/i.test(name)) name = `${name}.md`;
      if (!node.docId) {
        window.alert('Cannot rename: no encryption key for this item.');
        return;
      }
      try {
        const encryptedName = await encryptNameFor(node.docId, name);
        await api.update(node.id, { name: encryptedName });
        await reload();
      } catch (e) {
        window.alert((e as Error).message);
      }
    },
    [api, reload, nameOf, encryptNameFor],
  );

  const remove = useCallback(
    async (node: TreeNodeDto) => {
      if (!window.confirm(`Delete “${nameOf(node)}”? This cannot be undone.`)) return;
      try {
        await api.remove(node.id);
        await reload();
      } catch (e) {
        window.alert((e as Error).message);
      }
    },
    [api, reload, nameOf],
  );

  const renderRow = (node: TreeNode, level: number): React.ReactNode => {
    const isFolder = node.kind === 'folder';
    const isCollapsed = collapsed.has(node.id);
    const caps = node.capabilities;
    return (
      <li key={node.id}>
        <div
          className={`oc-tree-row${selectedId === node.id ? ' is-selected' : ''}`}
          style={{ paddingLeft: 6 + level * 14 }}
          onClick={() => (isFolder ? toggle(node.id) : onOpen(node))}
          title={nameOf(node)}
        >
          <span className="oc-tree-twirl">
            {isFolder && <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />}
          </span>
          <span className="oc-tree-icon">
            <Icon
              name={
                isFolder
                    ? 'folder'
                    : node.isText
                      ? 'file'
                      : 'image'
              }
              size={14}
            />
          </span>
          <span className="oc-tree-label">{nameOf(node)}</span>
          <span className="oc-tree-actions" onClick={(e) => e.stopPropagation()}>
            {isFolder && hasCapability(caps, 'create') && (
              <>
                <button className="oc-icon-btn" title="New note" onClick={() => void create(node.id, 'file')}>
                  <Icon name="plus" size={14} />
                </button>
                <button
                  className="oc-icon-btn"
                  title="New folder"
                  onClick={() => void create(node.id, 'folder')}
                >
                  <Icon name="folderPlus" size={14} />
                </button>
              </>
            )}
            {hasCapability(caps, 'edit') && (
              <button className="oc-icon-btn" title="Rename" onClick={() => void rename(node)}>
                <Icon name="pencil" size={14} />
              </button>
            )}
            {hasCapability(caps, 'delete') && (
              <button className="oc-icon-btn" title="Delete" onClick={() => void remove(node)}>
                <Icon name="trash" size={14} />
              </button>
            )}
            {hasCapability(caps, 'share') && (
              <button className="oc-icon-btn" title="Share" onClick={() => setAclNode(node)}>
                <Icon name="share" size={14} />
              </button>
            )}
          </span>
        </div>
        {isFolder && !isCollapsed && node.children.length > 0 && (
          <ul className="oc-tree">{node.children.map((c) => renderRow(c, level + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <>
      <div className="oc-sidebar-header">
        <span>Files</span>
        <span className="oc-sidebar-actions">
          {rootCanCreate && (
            <>
              <button className="oc-icon-btn" title="New note" onClick={() => void create(null, 'file')}>
                <Icon name="plus" size={15} />
              </button>
              <button className="oc-icon-btn" title="New folder" onClick={() => void create(null, 'folder')}>
                <Icon name="folderPlus" size={15} />
              </button>
            </>
          )}
          {root && hasCapability(root.capabilities, 'share') && (
            <button
              className="oc-icon-btn"
              title="Vault permissions"
              onClick={() => setAclNode(root)}
            >
              <Icon name="share" size={15} />
            </button>
          )}
          <button className="oc-icon-btn" title="Refresh" onClick={() => void reload()}>
            <Icon name="refresh" size={15} />
          </button>
        </span>
      </div>
      <div className="oc-sidebar-body">
        {error && <div className="oc-error" style={{ padding: '0 6px' }}>{error}</div>}
        {forest.length === 0 && !error && (
          <p className="oc-faint" style={{ padding: '8px 10px', fontSize: 13 }}>
            No accessible files yet.
          </p>
        )}
        <ul className="oc-tree">{forest.map((n) => renderRow(n, 0))}</ul>
      </div>
      {aclNode && (
        <AclPanel
          node={aclNode}
          onClose={() => {
            setAclNode(null);
            void reload();
          }}
        />
      )}
    </>
  );
}
