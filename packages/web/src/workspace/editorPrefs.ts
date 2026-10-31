import { useCallback, useEffect, useState } from 'react';
import type { VaultStore } from '../vault/VaultStore';

/**
 * Editor options, named as in Obsidian's `.obsidian/app.json`. The vault's
 * app.json (synced from the desktop) gives the defaults; changes made in the
 * browser are kept per device and vault, so they never fight the desktop.
 */
export interface EditorPrefs {
  /** Limit the text to ~750px ("Lesbare Zeilenlänge"). */
  readableLineLength: boolean;
  /** Editing mode: Live Preview (true) or source mode. */
  livePreview: boolean;
  /** Mode of newly opened notes: editing ('source') or reading ('preview'). */
  defaultViewMode: 'source' | 'preview';
  showLineNumber: boolean;
  tabSize: number;
}

export const OBSIDIAN_DEFAULTS: EditorPrefs = {
  readableLineLength: true,
  livePreview: true,
  defaultViewMode: 'source',
  showLineNumber: false,
  tabSize: 4,
};

const KEYS = Object.keys(OBSIDIAN_DEFAULTS) as Array<keyof EditorPrefs>;
const overrideKey = (vaultId: string): string => `oc.editorPrefs.${vaultId}`;

function pick(src: Record<string, unknown> | null | undefined): Partial<EditorPrefs> {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (src && typeof src[k] === typeof OBSIDIAN_DEFAULTS[k]) out[k] = src[k];
  if (out.defaultViewMode !== undefined && out.defaultViewMode !== 'source' && out.defaultViewMode !== 'preview') delete out.defaultViewMode;
  return out as Partial<EditorPrefs>;
}

function readOverrides(vaultId: string): Partial<EditorPrefs> {
  try {
    return pick(JSON.parse(localStorage.getItem(overrideKey(vaultId)) ?? 'null') as Record<string, unknown>);
  } catch {
    return {};
  }
}

export interface EditorPrefsApi {
  prefs: EditorPrefs;
  /** Values from the vault's app.json (what the desktop uses). */
  vault: EditorPrefs;
  /** Keys changed on this device. */
  overridden: Array<keyof EditorPrefs>;
  set(patch: Partial<EditorPrefs>): void;
  reset(): void;
}

export function useEditorPrefs(store: VaultStore): EditorPrefsApi {
  const [vault, setVault] = useState<EditorPrefs>(OBSIDIAN_DEFAULTS);
  const [overrides, setOverrides] = useState<Partial<EditorPrefs>>(() => readOverrides(store.vaultId));

  useEffect(() => {
    let cancelled = false;
    setOverrides(readOverrides(store.vaultId));
    setVault(OBSIDIAN_DEFAULTS);
    void store
      .readConfigJson<Record<string, unknown>>('app.json')
      .then((app) => !cancelled && setVault({ ...OBSIDIAN_DEFAULTS, ...pick(app) }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [store]);

  const set = useCallback(
    (patch: Partial<EditorPrefs>) => {
      setOverrides((cur) => {
        const next: Partial<EditorPrefs> = { ...cur, ...patch };
        // Back to the vault's value → follow the vault again.
        for (const k of Object.keys(patch) as Array<keyof EditorPrefs>) if (next[k] === vault[k]) delete next[k];
        if (Object.keys(next).length) localStorage.setItem(overrideKey(store.vaultId), JSON.stringify(next));
        else localStorage.removeItem(overrideKey(store.vaultId));
        return next;
      });
    },
    [store.vaultId, vault],
  );
  const reset = useCallback(() => {
    localStorage.removeItem(overrideKey(store.vaultId));
    setOverrides({});
  }, [store.vaultId]);

  return {
    prefs: { ...vault, ...overrides },
    vault,
    overridden: Object.keys(overrides) as Array<keyof EditorPrefs>,
    set,
    reset,
  };
}
