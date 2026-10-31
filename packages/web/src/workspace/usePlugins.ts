import { useCallback, useEffect, useRef, useState } from 'react';
import { installObsidianDom } from '../obsidian/dom';
import { PluginHost } from '../obsidian/PluginHost';
import { pluginRegistry, type WorkspaceHost } from '../obsidian/host';

/**
 * Plugin lifecycle for the open vault, with trust-on-first-use: community
 * plugins run with full access to the decrypted vault (exactly like in
 * Obsidian), so they only load after the user trusted this vault's plugin
 * code ON THIS DEVICE. A changed main.js (new version, or a collaborator
 * swapping code) asks again — the browser equivalent of Obsidian's
 * "restricted mode".
 */
export type TrustState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none' } // vault has no community plugins
  | { kind: 'ask'; changed: string[]; hashes: Record<string, string> }
  | { kind: 'restricted' }
  | { kind: 'loaded' };

const trustKey = (vaultId: string): string => `oc.pluginTrust.${vaultId}`;
const restrictedKey = (vaultId: string): string => `oc.pluginRestricted.${vaultId}`;

export function usePlugins(host: WorkspaceHost | null): {
  trust: TrustState;
  accept: () => void;
  restrict: () => void;
  reset: () => void;
  pluginHost: PluginHost | null;
} {
  const [trust, setTrust] = useState<TrustState>({ kind: 'idle' });
  const phRef = useRef<PluginHost | null>(null);
  const [ph, setPh] = useState<PluginHost | null>(null);
  const vaultId = host?.store.vaultId ?? null;

  const load = useCallback(async (p: PluginHost) => {
    await p.loadVaultPlugins();
    setTrust({ kind: 'loaded' });
    host?.rerenderActive();
  }, [host]);

  useEffect(() => {
    if (!host || !vaultId) return;
    let cancelled = false;
    installObsidianDom();
    const p = new PluginHost(host);
    phRef.current = p;
    setPh(p);
    setTrust({ kind: 'checking' });
    void (async () => {
      // Plugins (Dataview) index the vault on load — wait for our index first.
      await host.store.loadAllNotes().catch(() => undefined);
      const hashes = await p.pluginCodeHashes().catch(() => ({}) as Record<string, string>);
      if (cancelled) return;
      if (Object.keys(hashes).length === 0) {
        setTrust({ kind: 'none' });
        return;
      }
      let trusted: Record<string, string> = {};
      try {
        trusted = JSON.parse(localStorage.getItem(trustKey(vaultId)) ?? '{}') as Record<string, string>;
      } catch {
        /* none */
      }
      const changed = Object.keys(hashes).filter((id) => trusted[id] !== hashes[id]);
      if (changed.length === 0) await load(p);
      else if (localStorage.getItem(restrictedKey(vaultId)) === JSON.stringify(hashes)) setTrust({ kind: 'restricted' });
      else setTrust({ kind: 'ask', changed, hashes });
    })();
    return () => {
      cancelled = true;
      phRef.current = null;
      void p.unloadAll().catch(() => undefined);
      pluginRegistry.clear();
    };
  }, [host, vaultId, load]);

  const accept = useCallback(() => {
    if (trust.kind !== 'ask' || !vaultId || !phRef.current) return;
    localStorage.setItem(trustKey(vaultId), JSON.stringify(trust.hashes));
    localStorage.removeItem(restrictedKey(vaultId));
    setTrust({ kind: 'checking' });
    void load(phRef.current);
  }, [trust, vaultId, load]);

  const restrict = useCallback(() => {
    if (trust.kind !== 'ask' || !vaultId) return;
    localStorage.setItem(restrictedKey(vaultId), JSON.stringify(trust.hashes));
    setTrust({ kind: 'restricted' });
  }, [trust, vaultId]);

  const reset = useCallback(() => {
    if (!vaultId) return;
    localStorage.removeItem(trustKey(vaultId));
    localStorage.removeItem(restrictedKey(vaultId));
    window.location.reload();
  }, [vaultId]);

  return { trust, accept, restrict, reset, pluginHost: ph };
}
