import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TreeNodeDto } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useE2ee } from '../e2ee/E2eeContext';
import { VaultStore } from './VaultStore';

/**
 * Loads the tree (ETag-polled), decrypts every node name on the device, lists
 * the vaults the user can see, and owns the VaultStore of the selected vault.
 */

export interface VaultInfo {
  id: string;
  name: string;
  node: TreeNodeDto;
}

interface VaultContextValue {
  nodes: TreeNodeDto[];
  names: Map<string, string>;
  vaults: VaultInfo[];
  /** Content outside any vault (pre-multi-vault data) exists. */
  hasLegacyContent: boolean;
  currentVaultId: string | null;
  selectVault: (id: string | null) => void;
  createVault: (name: string) => Promise<string>;
  renameVault: (id: string, name: string) => Promise<void>;
  deleteVault: (id: string) => Promise<void>;
  store: VaultStore | null;
  reloadTree: () => Promise<void>;
  treeError: string | null;
}

const Ctx = createContext<VaultContextValue | null>(null);
const LAST_VAULT_KEY = 'oc.lastVault';

/** The vault id in the URL hash (`#/vault/<id>/<path>`), if any. */
export function vaultIdFromHash(): string | null {
  const m = /^#\/vault\/([0-9a-f-]{36})/.exec(window.location.hash);
  return m ? m[1] : null;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { authFetch, treeFetch, user } = useAuth();
  const { status, decryptName, getContentKey, prepareName, storeContentKey, keyForGrantees, encryptNameFor } =
    useE2ee();
  const [nodes, setNodes] = useState<TreeNodeDto[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [currentVaultId, setCurrentVaultId] = useState<string | null>(
    () => vaultIdFromHash() ?? localStorage.getItem(LAST_VAULT_KEY),
  );
  const etag = useRef<string | null>(null);
  const nodesRef = useRef<TreeNodeDto[]>([]);
  const namesRef = useRef<Map<string, string>>(new Map());

  const reloadTree = useCallback(async () => {
    try {
      const res = await treeFetch(etag.current);
      etag.current = res.etag;
      if (!res.notModified && res.tree) {
        nodesRef.current = res.tree.nodes;
        setNodes(res.tree.nodes);
      }
      setTreeError(null);
    } catch (e) {
      setTreeError((e as Error).message);
    }
  }, [treeFetch]);

  // Initial load + background poll (cheap: ETag/304; paused while hidden).
  useEffect(() => {
    if (!user) return;
    void reloadTree();
    const tick = (): void => {
      if (document.visibilityState === 'visible') void reloadTree();
    };
    const id = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [user, reloadTree]);

  // Decrypt names locally; only nodes whose ciphertext changed are re-done.
  const decryptedFor = useRef(new Map<string, { cipher: string; plain: string }>());
  useEffect(() => {
    if (status !== 'unlocked') return;
    let active = true;
    void (async () => {
      const cache = decryptedFor.current;
      const out = new Map<string, string>();
      await Promise.all(
        nodes.map(async (n) => {
          const hit = cache.get(n.id);
          if (hit && hit.cipher === n.name) {
            out.set(n.id, hit.plain);
            return;
          }
          const plain = await decryptName(n.docId, n.name);
          // decryptName falls back to the ciphertext when there's no key.
          if (plain !== n.name || n.name === '') {
            cache.set(n.id, { cipher: n.name, plain });
            out.set(n.id, plain);
          }
        }),
      );
      if (!active) return;
      namesRef.current = out;
      setNames(out);
    })();
    return () => {
      active = false;
    };
  }, [nodes, status, decryptName]);

  const vaults = useMemo<VaultInfo[]>(
    () =>
      nodes
        .filter((n) => n.isVault)
        .map((n) => ({ id: n.id, name: names.get(n.id) ?? '…', node: n }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [nodes, names],
  );
  const hasLegacyContent = useMemo(
    () => nodes.some((n) => n.depth === 1 && !n.isVault && !n.systemType),
    [nodes],
  );

  // Fall back to the first vault when the selection is gone/unset.
  useEffect(() => {
    if (vaults.length === 0) return;
    if (!currentVaultId || !vaults.some((v) => v.id === currentVaultId)) {
      setCurrentVaultId(vaults[0].id);
    }
  }, [vaults, currentVaultId]);

  const selectVault = useCallback((id: string | null) => {
    setCurrentVaultId(id);
    if (id) localStorage.setItem(LAST_VAULT_KEY, id);
    window.location.hash = id ? `#/vault/${id}` : '';
  }, []);

  // One VaultStore per selected vault.
  const deps = useMemo(
    () => ({
      authFetch: <T,>(path: string, opts?: { method?: string; body?: unknown }) => authFetch<T>(path, opts),
      getContentKey,
      prepareName,
      storeContentKey,
      keyForGrantees,
      encryptNameFor,
      reloadTree: async () => {
        await reloadTree();
      },
    }),
    [authFetch, getContentKey, prepareName, storeContentKey, keyForGrantees, encryptNameFor, reloadTree],
  );
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const vaultNode = vaults.find((v) => v.id === currentVaultId)?.node ?? null;
  const vaultName = vaults.find((v) => v.id === currentVaultId)?.name ?? '';
  const [store, setStore] = useState<VaultStore | null>(null);
  useEffect(() => {
    if (!vaultNode || status !== 'unlocked' || !vaultName || vaultName === '…') {
      setStore(null);
      return;
    }
    // Stable deps proxy: the store must survive token refreshes (which
    // re-create authFetch & co).
    const s = new VaultStore(vaultNode, vaultName, {
      authFetch: (p, o) => depsRef.current.authFetch(p, o),
      getContentKey: (d) => depsRef.current.getContentKey(d),
      prepareName: (n) => depsRef.current.prepareName(n),
      storeContentKey: (d, k) => depsRef.current.storeContentKey(d, k),
      keyForGrantees: (d, k) => depsRef.current.keyForGrantees(d, k),
      encryptNameFor: (d, n) => depsRef.current.encryptNameFor(d, n),
      reloadTree: () => depsRef.current.reloadTree(),
    });
    s.setTree(nodesRef.current, namesRef.current);
    setStore(s);
    void s.loadAllNotes().catch((e) => console.error('index failed', e));
    return () => s.destroy();
    // Re-create only when the vault (or lock state) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultNode?.id, status, vaultName]);

  // Feed tree changes into the live store.
  useEffect(() => {
    if (store) store.setTree(nodes, names);
  }, [store, nodes, names]);

  // Pick up edits made elsewhere (other devices) every minute while visible.
  useEffect(() => {
    if (!store) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible' && store.indexed) void store.refreshAllNotes().catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [store]);

  const createVault = useCallback(
    async (name: string) => {
      const { encryptedName, contentKey } = await prepareName(name);
      const node = await authFetch<TreeNodeDto>('/nodes', {
        method: 'POST',
        body: { parentId: null, kind: 'folder', name: encryptedName, isVault: true },
      });
      await storeContentKey(node.docId!, contentKey);
      await keyForGrantees(node.docId!, contentKey).catch(() => 0);
      await reloadTree();
      selectVault(node.id);
      return node.id;
    },
    [authFetch, prepareName, storeContentKey, keyForGrantees, reloadTree, selectVault],
  );

  const renameVault = useCallback(
    async (id: string, name: string) => {
      const v = nodes.find((n) => n.id === id);
      if (!v?.docId) return;
      await authFetch(`/nodes/${id}`, { method: 'PATCH', body: { name: await encryptNameFor(v.docId, name) } });
      await reloadTree();
    },
    [nodes, authFetch, encryptNameFor, reloadTree],
  );

  const deleteVault = useCallback(
    async (id: string) => {
      await authFetch(`/nodes/${id}`, { method: 'DELETE' });
      if (currentVaultId === id) selectVault(null);
      await reloadTree();
    },
    [authFetch, currentVaultId, selectVault, reloadTree],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      nodes,
      names,
      vaults,
      hasLegacyContent,
      currentVaultId,
      selectVault,
      createVault,
      renameVault,
      deleteVault,
      store,
      reloadTree,
      treeError,
    }),
    [nodes, names, vaults, hasLegacyContent, currentVaultId, selectVault, createVault, renameVault, deleteVault, store, reloadTree, treeError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVaults(): VaultContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useVaults outside VaultProvider');
  return v;
}

/** Re-render on VaultStore events (tree/content/index changes). */
export function useStoreVersion(store: VaultStore | null, events = ['tree', 'resolved', 'changed']): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!store) return;
    let raf = 0;
    const bump = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setV((x) => x + 1));
    };
    const refs = events.map((e) => store.on(e, bump));
    return () => {
      cancelAnimationFrame(raf);
      refs.forEach((r) => store.offref(r));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
  return v;
}
