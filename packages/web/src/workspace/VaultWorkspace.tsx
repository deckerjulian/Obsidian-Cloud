import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import type { TreeNodeDto } from '@oc/shared';
import { useStoreVersion } from '../vault/VaultContext';
import { useAuth } from '../auth/AuthContext';
import type { VaultStore } from '../vault/VaultStore';
import { parseLinktext } from '../vault/linkResolver';
import { setDefaultLinkHandler } from '../markdown/render';
import { pluginRegistry, type ViewMode, type WorkspaceHost } from '../obsidian/host';
import { AclPanel } from '../acl/AclPanel';
import { NoteView } from './NoteView';
import { FileView } from './FileView';
import { BacklinksPanel, BookmarksPanel, ContextMenu, LIcon, OutlinePanel, SearchPanel, VaultExplorer, type MenuItem } from './Sidebar';
import { Palette, type PaletteItem } from './Palette';
import { applyVaultAppearance } from './appearance';
import { usePlugins } from './usePlugins';
import { PluginSettings, type SettingsTab } from './PluginSettings';
import { useEditorPrefs } from './editorPrefs';

interface Tab {
  id: string;
  path: string | null;
  viewType?: string;
  mode: ViewMode;
  /** Editing in source mode instead of Live Preview (unset: the default). */
  source?: boolean;
  subpath?: string;
  back: string[];
  forward: string[];
}

type LeftPanel = 'files' | 'search' | 'bookmarks';
type RightPanel = 'outline' | 'backlinks';

let tabSeq = 0;
const newTab = (path: string | null, mode: ViewMode = 'source', subpath?: string): Tab => ({
  id: `t${++tabSeq}`,
  path,
  mode,
  subpath,
  back: [],
  forward: [],
});

const tabsKey = (vaultId: string): string => `oc.tabs.${vaultId}`;

/** Path from the URL hash (`#/vault/<id>/<encoded path>`). */
function pathFromHash(vaultId: string): string | null {
  const prefix = `#/vault/${vaultId}/`;
  if (!window.location.hash.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(prefix.length));
  } catch {
    return null;
  }
}

/**
 * The Obsidian-like workspace for one vault: file explorer / search /
 * bookmarks on the left, tabs with reading view + editor in the middle,
 * outline / backlinks on the right, quick switcher, command palette, and the
 * vault's community plugins running on top.
 */
export function VaultWorkspace({
  store,
  vaultSwitcher,
  onError,
}: {
  store: VaultStore;
  vaultSwitcher: React.ReactNode;
  onError: (msg: string) => void;
}) {
  useStoreVersion(store, ['tree']);
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const fromHash = pathFromHash(store.vaultId);
    try {
      const saved = JSON.parse(localStorage.getItem(tabsKey(store.vaultId)) ?? 'null') as {
        tabs: Array<{ path: string | null; mode: ViewMode; source?: boolean }>;
        active: number;
      } | null;
      if (saved?.tabs?.length) {
        const restored = saved.tabs.map((t): Tab => ({ ...newTab(t.path, t.mode), source: t.source }));
        if (fromHash && !restored.some((t) => t.path === fromHash)) restored.push(newTab(fromHash));
        return restored;
      }
    } catch {
      /* ignore */
    }
    return [newTab(fromHash)];
  });
  const [activeId, setActiveId] = useState<string>(() => {
    const fromHash = pathFromHash(store.vaultId);
    return tabs.find((t) => t.path === fromHash)?.id ?? tabs[0].id;
  });
  const [left, setLeft] = useState<LeftPanel>('files');
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 900);
  const [right, setRight] = useState<RightPanel>('outline');
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 1300);
  const [searchQuery, setSearchQuery] = useState('');
  const [palette, setPalette] = useState<'switcher' | 'commands' | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const setShowPluginSettings = (open: boolean): void => setSettingsTab(open ? 'plugins' : null);
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | null>(null);
  const editorPrefs = useEditorPrefs(store);
  const { prefs } = editorPrefs;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [shareNode, setShareNode] = useState<TreeNodeDto | null>(null);
  const [, setRegVersion] = useState(0);
  const editorView = useRef<EditorView | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);

  // Phones: sidebars are overlays — at most one open, closed by a tap on the
  // note, and both collapse when the window shrinks to phone width.
  const narrow = (): boolean => window.innerWidth <= 700;
  useEffect(() => {
    if (narrow() && leftOpen && rightOpen) setRightOpen(false);
  }, [leftOpen, rightOpen]);
  useEffect(() => {
    let wasNarrow = narrow();
    const onResize = (): void => {
      const n = narrow();
      if (n && !wasNarrow) {
        setLeftOpen(false);
        setRightOpen(false);
      }
      wasNarrow = n;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const closeOverlays = (): void => {
    if (!narrow()) return;
    setLeftOpen(false);
    setRightOpen(false);
  };

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeFile = active.path ? store.getFile(active.path) : null;

  useEffect(() => pluginRegistry.subscribe(() => setRegVersion((v) => v + 1)), []);

  // Persist open tabs per vault; mirror the active file into the URL.
  useEffect(() => {
    localStorage.setItem(
      tabsKey(store.vaultId),
      JSON.stringify({ tabs: tabs.map((t) => ({ path: t.path, mode: t.mode, source: t.source })), active: tabs.indexOf(active) }),
    );
    const want = `#/vault/${store.vaultId}${active.path ? `/${encodeURIComponent(active.path)}` : ''}`;
    if (window.location.hash !== want) history.replaceState(null, '', want);
  }, [tabs, active, store.vaultId]);

  // Vault appearance (theme, fonts, snippets).
  useEffect(() => {
    let undo: (() => void) | null = null;
    let cancelled = false;
    void applyVaultAppearance(store).then((u) => (cancelled ? u() : (undo = u)));
    return () => {
      cancelled = true;
      undo?.();
    };
  }, [store]);

  const updateTab = useCallback((id: string, fn: (t: Tab) => Tab) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  const openFile = useCallback(
    (path: string, opts: { newLeaf?: boolean; mode?: ViewMode; subpath?: string } = {}) => {
      if (opts.newLeaf) {
        const t = newTab(path, opts.mode ?? prefsRef.current.defaultViewMode, opts.subpath);
        setTabs((ts) => [...ts, t]);
        setActiveId(t.id);
        return;
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.id === activeId
            ? {
                ...t,
                path,
                viewType: undefined,
                subpath: opts.subpath,
                mode: opts.mode ?? t.mode,
                back: t.path && t.path !== path ? [...t.back, t.path] : t.back,
                forward: t.path !== path ? [] : t.forward,
              }
            : t,
        ),
      );
      if (window.innerWidth < 700) setLeftOpen(false);
    },
    [activeId],
  );

  const openLinkText = useCallback(
    (linktext: string, sourcePath: string, newLeaf = false) => {
      const { path, subpath } = parseLinktext(linktext);
      if (!path && subpath) {
        updateTab(activeId, (t) => ({ ...t, subpath }));
        return;
      }
      const target = store.resolveLink(path, sourcePath);
      if (target) {
        openFile(target.path, { newLeaf, subpath: subpath || undefined });
        return;
      }
      // Unresolved link: offer to create the note (like Obsidian does on click).
      if (!window.confirm(`„${path}“ existiert noch nicht. Jetzt anlegen?`)) return;
      const folder = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
      const newPath = `${path.includes('/') ? '' : folder ? `${folder}/` : ''}${path}${/\.\w+$/.test(path) ? '' : '.md'}`;
      store
        .create(newPath, '')
        .then(() => openFile(newPath, { newLeaf, mode: 'source' }))
        .catch((e) => onError((e as Error).message));
    },
    [store, openFile, activeId, updateTab, onError],
  );

  useEffect(() => {
    setDefaultLinkHandler(openLinkText);
  }, [openLinkText]);

  const toggleMode = useCallback(() => {
    updateTab(activeId, (t) => ({ ...t, mode: t.mode === 'preview' ? 'source' : 'preview' }));
  }, [activeId, updateTab]);
  /** Live Preview ⇄ source mode for the active tab (switches to editing). */
  const toggleSource = useCallback(() => {
    updateTab(activeId, (t) => ({ ...t, mode: 'source', source: !(t.source ?? !prefsRef.current.livePreview) }));
  }, [activeId, updateTab]);
  const toggleReadable = useCallback(() => {
    editorPrefs.set({ readableLineLength: !prefsRef.current.readableLineLength });
  }, [editorPrefs]);

  const goBack = useCallback(() => {
    updateTab(activeId, (t) => {
      const prev = t.back[t.back.length - 1];
      if (!prev) return t;
      return { ...t, path: prev, subpath: undefined, back: t.back.slice(0, -1), forward: t.path ? [t.path, ...t.forward] : t.forward };
    });
  }, [activeId, updateTab]);
  const goForward = useCallback(() => {
    updateTab(activeId, (t) => {
      const next = t.forward[0];
      if (!next) return t;
      return { ...t, path: next, subpath: undefined, forward: t.forward.slice(1), back: t.path ? [...t.back, t.path] : t.back };
    });
  }, [activeId, updateTab]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        if (ts.length === 1) return [{ ...ts[0], path: null, back: [], forward: [] }];
        const i = ts.findIndex((t) => t.id === id);
        const next = ts.filter((t) => t.id !== id);
        if (id === activeId) setActiveId(next[Math.max(0, i - 1)].id);
        return next;
      });
    },
    [activeId],
  );

  const newNote = useCallback(() => {
    const folder = activeFile?.parentPath ?? '';
    let name = 'Unbenannt';
    for (let i = 1; store.getFile(`${folder ? `${folder}/` : ''}${name}.md`); i++) name = `Unbenannt ${i}`;
    const path = `${folder ? `${folder}/` : ''}${name}.md`;
    store
      .create(path, '')
      .then(() => openFile(path, { mode: 'source' }))
      .catch((e) => onError((e as Error).message));
  }, [activeFile, store, openFile, onError]);

  // ── WorkspaceHost for the plugin API ───────────────────────────────────────
  const stateRef = useRef({ active, openFile, openLinkText, setRenderNonce });
  stateRef.current = { active, openFile, openLinkText, setRenderNonce };
  const host = useMemo<WorkspaceHost>(
    () => ({
      store,
      openFile: (p, o) => stateRef.current.openFile(p, o),
      openLinkText: (l, s, n) => stateRef.current.openLinkText(l, s, n),
      getActiveFilePath: () => stateRef.current.active.path,
      getActiveMode: () => (stateRef.current.active.path ? stateRef.current.active.mode : null),
      getActiveEditorView: () => (stateRef.current.active.mode === 'source' ? editorView.current : null),
      rerenderActive: () => stateRef.current.setRenderNonce((n) => n + 1),
      openView: (viewType) => {
        const t = newTab(null);
        t.viewType = viewType;
        setTabs((ts) => [...ts, t]);
        setActiveId(t.id);
      },
    }),
    [store],
  );
  const { user } = useAuth();
  // A `.obsidian` folder from before config protection existed: the first
  // admin / plugin admin to open the vault puts it under protection (until
  // then no plugin code is loaded from it).
  const [configReady, setConfigReady] = useState(() => store.configTrusted || !store.configFiles().length);
  useEffect(() => {
    let cancelled = false;
    const canManage = !!user && (user.isAdmin || user.isPluginAdmin);
    void store
      .protectConfigFolder(canManage)
      .catch((e) => console.warn('Could not protect the vault config folder:', e))
      .finally(() => !cancelled && setConfigReady(true));
    return () => {
      cancelled = true;
    };
  }, [store, user]);
  const { trust, accept, restrict, reset, pluginHost } = usePlugins(configReady ? host : null);

  useEffect(() => {
    pluginHost?.notifyFileOpen(active.path);
  }, [pluginHost, active.path, active.mode]);

  // ── keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setPalette('switcher');
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setPalette('commands');
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        toggleMode();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLeft('search');
        setLeftOpen(true);
      } else if (mod && e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (mod && e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'n' && e.altKey) {
        e.preventDefault();
        newNote();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
        // Notes save continuously; Obsidian's save command still runs so
        // plugins hooked on it (Linter's lint-on-save) work.
        e.preventDefault();
        pluginHost?.executeCommand('editor:save-file');
      } else if (mod && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        setSettingsTab('editor');
      } else if (mod && e.key.toLowerCase() === 'w' && e.altKey) {
        e.preventDefault();
        closeTab(activeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMode, goBack, goForward, newNote, closeTab, activeId, pluginHost]);

  // EditorSuggest popups (plugins) get the keys first while one is open.
  useEffect(() => {
    if (!pluginHost) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.cm-editor') && pluginHost.handleEditorKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pluginHost]);

  // Plugins open/close the settings dialog (app.setting.open()).
  useEffect(() => {
    const open = (): void => setSettingsTab('plugins');
    const close = (): void => setSettingsTab(null);
    window.addEventListener('oc:open-settings', open);
    window.addEventListener('oc:close-settings', close);
    return () => {
      window.removeEventListener('oc:open-settings', open);
      window.removeEventListener('oc:close-settings', close);
    };
  }, []);

  // Tag clicks in notes open the search.
  useEffect(() => {
    const onSearch = (e: Event): void => {
      setSearchQuery((e as CustomEvent<string>).detail);
      setLeft('search');
      setLeftOpen(true);
    };
    window.addEventListener('oc:search', onSearch);
    return () => window.removeEventListener('oc:search', onSearch);
  }, []);

  // Browser back/forward / pasted links.
  useEffect(() => {
    const onHash = (): void => {
      const p = pathFromHash(store.vaultId);
      if (p && p !== stateRef.current.active.path && store.getFile(p)) stateRef.current.openFile(p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [store]);

  // ── palettes ───────────────────────────────────────────────────────────────
  const switcherItems = useMemo<PaletteItem[]>(() => {
    if (palette !== 'switcher') return [];
    return store
      .getFiles()
      .map((f) => ({
        id: f.path,
        title: f.extension === 'md' ? f.path.replace(/\.md$/, '') : f.path,
        run: () => openFile(f.path),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [palette, store, openFile]);
  const commandItems = useMemo<PaletteItem[]>(() => {
    if (palette !== 'commands') return [];
    const builtin: PaletteItem[] = [
      { id: 'oc:switcher', title: 'Schnellwechsler: Datei öffnen', note: '⌘O', run: () => setTimeout(() => setPalette('switcher'), 0) },
      { id: 'oc:search', title: 'Suche: Im Vault suchen', note: '⌘⇧F', run: () => { setLeft('search'); setLeftOpen(true); } },
      { id: 'oc:toggle', title: 'Lese-/Bearbeitungsmodus umschalten', note: '⌘E', run: toggleMode },
      { id: 'oc:toggle-source', title: 'Live Preview / Quelltextmodus umschalten', run: toggleSource },
      { id: 'oc:toggle-readable', title: `Lesbare Zeilenlänge ${prefs.readableLineLength ? 'ausschalten' : 'einschalten'}`, run: toggleReadable },
      { id: 'oc:settings', title: 'Einstellungen öffnen', note: '⌘,', run: () => setSettingsTab('editor') },
      { id: 'oc:new', title: 'Neue Notiz erstellen', note: '⌘⌥N', run: newNote },
      { id: 'oc:back', title: 'Navigation: Zurück', run: goBack },
      { id: 'oc:forward', title: 'Navigation: Vorwärts', run: goForward },
      { id: 'oc:outline', title: 'Gliederung anzeigen', run: () => { setRight('outline'); setRightOpen(true); } },
      { id: 'oc:backlinks', title: 'Backlinks anzeigen', run: () => { setRight('backlinks'); setRightOpen(true); } },
      { id: 'oc:plugins', title: 'Community-Plugins: Einstellungen', run: () => setShowPluginSettings(true) },
      { id: 'oc:reindex', title: 'Vault neu indizieren', run: () => void store.refreshAllNotes() },
    ];
    const fromPlugins: PaletteItem[] = [...pluginRegistry.commands.values()]
      .filter((c) => {
        try {
          return c.check();
        } catch {
          return false;
        }
      })
      .map((c) => ({
        id: c.id,
        title: c.name,
        run: () => {
          try {
            void Promise.resolve(c.run()).catch((e) => onError(`${c.name}: ${(e as Error).message}`));
          } catch (e) {
            onError(`${c.name}: ${(e as Error).message}`);
          }
        },
      }));
    return [...builtin, ...fromPlugins].sort((a, b) => a.title.localeCompare(b.title));
  }, [palette, toggleMode, toggleSource, toggleReadable, prefs.readableLineLength, newNote, goBack, goForward, store, onError]);

  // ── render ─────────────────────────────────────────────────────────────────
  const outlineJump = (heading: string): void => {
    if (active.mode === 'preview') {
      const el = Array.from(document.querySelectorAll<HTMLElement>('.oc-main-view [data-heading]')).find(
        (h) => (h.dataset.heading ?? '').trim() === heading.trim(),
      );
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else {
      // Editing: move the cursor to the heading.
      const view = editorView.current;
      const h = active.path ? store.getFileCache(active.path)?.headings?.find((x) => x.heading.trim() === heading.trim()) : undefined;
      if (!view || !h || h.position.start.offset > view.state.doc.length) return;
      const pos = h.position.start.offset;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
      view.focus();
    }
  };

  const isSource = active.source ?? !prefs.livePreview;
  const viewMenuItems = (): MenuItem[] => [
    active.mode === 'preview'
      ? { label: 'Bearbeiten', icon: 'edit', onClick: toggleMode }
      : { label: 'Lesemodus', icon: 'book-open', onClick: toggleMode },
    {
      label: active.mode === 'source' && !isSource ? 'Quelltextmodus' : 'Live Preview',
      icon: active.mode === 'source' && !isSource ? 'code-2' : 'eye',
      onClick: () =>
        active.mode === 'source' ? toggleSource() : updateTab(activeId, (t) => ({ ...t, mode: 'source', source: false })),
    },
    {
      label: prefs.readableLineLength ? 'Volle Fensterbreite nutzen' : 'Lesbare Zeilenlänge',
      icon: 'text-select',
      onClick: toggleReadable,
    },
    { label: 'Editor-Einstellungen…', icon: 'settings', onClick: () => setSettingsTab('editor') },
  ];
  const pluginView = active.viewType ? pluginRegistry.views.get(active.viewType) : undefined;
  const ribbon = [...pluginRegistry.ribbonIcons.values()];
  const words = activeFile?.extension === 'md' ? (store.cachedText(activeFile.path) ?? '').split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className={`oc-vault-workspace${leftOpen ? '' : ' is-left-collapsed'}${rightOpen ? '' : ' is-right-collapsed'}`}>
      <div className="workspace-ribbon side-dock-ribbon mod-left">
        <button className={`side-dock-ribbon-action${left === 'files' && leftOpen ? ' is-active' : ''}`} title="Dateien" onClick={() => { setLeft('files'); setLeftOpen(left !== 'files' || !leftOpen); }}>
          <LIcon name="folder" size={18} />
        </button>
        <button className={`side-dock-ribbon-action${left === 'search' && leftOpen ? ' is-active' : ''}`} title="Suche (⌘⇧F)" onClick={() => { setLeft('search'); setLeftOpen(left !== 'search' || !leftOpen); }}>
          <LIcon name="search" size={18} />
        </button>
        <button className={`side-dock-ribbon-action${left === 'bookmarks' && leftOpen ? ' is-active' : ''}`} title="Lesezeichen" onClick={() => { setLeft('bookmarks'); setLeftOpen(left !== 'bookmarks' || !leftOpen); }}>
          <LIcon name="bookmark" size={18} />
        </button>
        <button className="side-dock-ribbon-action" title="Schnellwechsler (⌘O)" onClick={() => setPalette('switcher')}>
          <LIcon name="file-text" size={18} />
        </button>
        <button className="side-dock-ribbon-action" title="Befehlspalette (⌘P)" onClick={() => setPalette('commands')}>
          <LIcon name="terminal" size={18} />
        </button>
        {ribbon.map((r) => (
          <button key={r.id} className="side-dock-ribbon-action" title={r.title} onClick={(e) => r.onClick(e.nativeEvent)}>
            <LIcon name={r.icon} size={18} />
          </button>
        ))}
        <span className="oc-ribbon-spacer" />
        <button className="side-dock-ribbon-action" title="Community-Plugins" onClick={() => setShowPluginSettings(true)}>
          <LIcon name="plug-zap" size={18} />
        </button>
        <button className="side-dock-ribbon-action" title="Einstellungen (⌘,)" onClick={() => setSettingsTab('editor')}>
          <LIcon name="settings" size={18} />
        </button>
      </div>

      {leftOpen && (
        <div className="workspace-split mod-left-split oc-left">
          <div className="oc-left-body">
            {left === 'files' && (
              <VaultExplorer
                store={store}
                activePath={active.path}
                onOpen={(p, n) => openFile(p, { newLeaf: n })}
                onShare={setShareNode}
                onError={onError}
              />
            )}
            {left === 'search' && <SearchPanel store={store} initialQuery={searchQuery} onOpen={(p) => openFile(p)} />}
            {left === 'bookmarks' && (
              <BookmarksPanel
                store={store}
                onOpen={(p, sub) => openFile(p, { subpath: sub })}
                onSearch={(q) => {
                  setSearchQuery(q);
                  setLeft('search');
                }}
              />
            )}
          </div>
          {vaultSwitcher}
        </div>
      )}

      <div className="workspace-split mod-root oc-center">
        <div className="workspace-tab-header-container">
          <button className="clickable-icon oc-tab-nav" title="Linke Seitenleiste" onClick={() => setLeftOpen((o) => !o)}>
            <LIcon name="panel-left" size={16} />
          </button>
          <div className="workspace-tab-header-container-inner">
            {tabs.map((t) => {
              const f = t.path ? store.getFile(t.path) : null;
              const title = t.viewType ? (pluginRegistry.views.get(t.viewType)?.displayText?.() ?? t.viewType) : f ? f.basename : t.path ? t.path.split('/').pop() : 'Neuer Tab';
              return (
                <div
                  key={t.id}
                  className={`workspace-tab-header${t.id === active.id ? ' is-active mod-active' : ''}`}
                  onClick={() => setActiveId(t.id)}
                  onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                  title={t.path ?? ''}
                >
                  <span className="workspace-tab-header-inner-title">{title}</span>
                  <span
                    className="workspace-tab-header-inner-close-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    <LIcon name="x" size={13} />
                  </span>
                </div>
              );
            })}
            <button className="clickable-icon oc-tab-new" title="Neuer Tab" onClick={() => { const t = newTab(null); setTabs((ts) => [...ts, t]); setActiveId(t.id); }}>
              <LIcon name="plus" size={15} />
            </button>
          </div>
          <button
            className="clickable-icon oc-tab-nav"
            title="Rechte Seitenleiste"
            onClick={() => {
              setRightOpen((o) => !o);
              if (narrow()) setLeftOpen(false);
            }}
          >
            <LIcon name="panel-right" size={16} />
          </button>
        </div>

        <div className="view-header">
          <div className="view-header-nav-buttons">
            <button className="clickable-icon" disabled={!active.back.length} onClick={goBack} title="Zurück">
              <LIcon name="arrow-left" size={16} />
            </button>
            <button className="clickable-icon" disabled={!active.forward.length} onClick={goForward} title="Vorwärts">
              <LIcon name="arrow-right" size={16} />
            </button>
          </div>
          <div className="view-header-title-container">
            {activeFile && (
              <div className="view-header-breadcrumbs">
                {activeFile.parentPath.split('/').filter(Boolean).map((seg, i) => (
                  <span key={i} className="view-header-breadcrumb">
                    {seg}
                    <span className="view-header-breadcrumb-separator">/</span>
                  </span>
                ))}
                <span className="view-header-title">{activeFile.extension === 'md' ? activeFile.basename : activeFile.name}</span>
              </div>
            )}
          </div>
          <div className="view-actions">
            {activeFile?.extension === 'md' && (
              <button className="clickable-icon view-action" title={active.mode === 'preview' ? 'Bearbeiten (⌘E)' : 'Lesen (⌘E)'} onClick={toggleMode}>
                <LIcon name={active.mode === 'preview' ? 'edit' : 'book-open'} size={16} />
              </button>
            )}
            {activeFile?.extension === 'md' && (
              <button
                className="clickable-icon view-action"
                title="Weitere Optionen"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setViewMenu({ x: Math.max(8, r.right - 240), y: r.bottom + 4 });
                }}
              >
                <LIcon name="more-vertical" size={16} />
              </button>
            )}
          </div>
        </div>

        <div className="oc-main-view workspace-leaf-content" onClick={closeOverlays} data-type={activeFile?.extension === 'md' ? 'markdown' : 'file'} key={`${active.id}:${renderNonce}`}>
          {pluginView ? (
            <PluginViewHost key={active.viewType} mount={pluginView.mount} state={{}} />
          ) : activeFile ? (
            activeFile.extension === 'md' ? (
              <NoteView
                key={activeFile.path}
                store={store}
                file={activeFile}
                mode={active.mode}
                livePreview={!(active.source ?? !prefs.livePreview)}
                readableLineLength={prefs.readableLineLength}
                showLineNumber={prefs.showLineNumber}
                tabSize={prefs.tabSize}
                subpath={active.subpath}
                onOpenLink={openLinkText}
                onEditorView={(v) => {
                  editorView.current = v;
                  pluginHost?.notifyLayoutChange();
                }}
                onEditorChange={() => pluginHost?.notifyEditorChange()}
              />
            ) : (
              <FileView key={activeFile.path} store={store} file={activeFile} />
            )
          ) : (
            <div className="oc-empty empty-state">
              {active.path ? (
                <p>„{active.path}“ wurde nicht gefunden.</p>
              ) : (
                <>
                  <div className="empty-state-title">{store.vaultName}</div>
                  <div className="empty-state-action-list">
                    <div className="empty-state-action" onClick={() => setPalette('switcher')}>Datei öffnen (⌘O)</div>
                    <div className="empty-state-action" onClick={newNote}>Neue Notiz (⌘⌥N)</div>
                    <div className="empty-state-action" onClick={() => setPalette('commands')}>Befehlspalette (⌘P)</div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {rightOpen && (
        <div className="workspace-split mod-right-split oc-right">
          <div className="nav-header oc-right-tabs">
            <button className={`clickable-icon${right === 'outline' ? ' is-active' : ''}`} title="Gliederung" onClick={() => setRight('outline')}>
              <LIcon name="list-tree" size={16} />
            </button>
            <button className={`clickable-icon${right === 'backlinks' ? ' is-active' : ''}`} title="Backlinks" onClick={() => setRight('backlinks')}>
              <LIcon name="link" size={16} />
            </button>
          </div>
          {right === 'outline' ? (
            <OutlinePanel store={store} path={activeFile?.extension === 'md' ? activeFile.path : null} onJump={outlineJump} />
          ) : (
            <BacklinksPanel store={store} path={activeFile?.path ?? null} onOpen={(p) => openFile(p)} />
          )}
        </div>
      )}

      <div className="status-bar">
        {[...pluginRegistry.statusBarItems.entries()].map(([id, el]) => (
          <StatusItem key={id} el={el} />
        ))}
        {trust.kind === 'restricted' && (
          <span className="status-bar-item is-clickable" onClick={reset} title="Plugins dieses Vaults sind deaktiviert">
            Eingeschränkter Modus
          </span>
        )}
        {!store.indexed && <span className="status-bar-item">Indiziere…</span>}
        {activeFile?.extension === 'md' && <span className="status-bar-item">{words.toLocaleString('de-DE')} Wörter</span>}
      </div>

      {palette === 'switcher' && (
        <Palette
          placeholder="Datei suchen…"
          items={switcherItems}
          onClose={() => setPalette(null)}
          onCreate={(q) => {
            const path = `${q}${/\.\w+$/.test(q) ? '' : '.md'}`;
            store.create(path, '').then(() => openFile(path, { mode: 'source' })).catch((e) => onError((e as Error).message));
          }}
        />
      )}
      {palette === 'commands' && <Palette placeholder="Befehl ausführen…" items={commandItems} onClose={() => setPalette(null)} />}
      {settingsTab && (
        <PluginSettings
          initialTab={settingsTab}
          editorPrefs={editorPrefs}
          trust={trust}
          onReset={reset}
          onClose={() => setSettingsTab(null)}
        />
      )}
      {viewMenu && (
        <ContextMenu
          x={viewMenu.x}
          y={viewMenu.y}
          onClose={() => setViewMenu(null)}
          items={viewMenuItems()}
        />
      )}
      {shareNode && <AclPanel node={shareNode} onClose={() => setShareNode(null)} />}
      {trust.kind === 'ask' && (
        <div className="modal-container">
          <div className="modal-bg" />
          <div className="modal oc-trust-modal">
            <div className="modal-title">Community-Plugins dieses Vaults aktivieren?</div>
            <div className="modal-content">
              <p>
                Dieser Vault enthält Community-Plugins. Plugins laufen mit vollem Zugriff auf deine entschlüsselten
                Notizen – genau wie in der Obsidian-App. Aktiviere sie nur, wenn du ihnen vertraust.
              </p>
              <p className="oc-faint">Neu oder geändert: {trust.changed.join(', ')}</p>
            </div>
            <div className="modal-button-container">
              <button className="mod-cta" onClick={accept}>
                Vertrauen &amp; aktivieren
              </button>
              <button onClick={restrict}>Eingeschränkter Modus</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Mount a plugin-provided DOM element (status bar item) inside React. */
function StatusItem({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.appendChild(el);
    return () => {
      if (el.parentElement === host) host.removeChild(el);
    };
  }, [el]);
  return <span ref={ref} className="oc-status-plugin" />;
}

function PluginViewHost({
  mount,
  state,
}: {
  mount: (container: HTMLElement, opts: { filePath?: string; state?: Record<string, unknown> }) => () => void;
  state: Record<string, unknown>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return mount(ref.current, { state });
  }, [mount, state]);
  return <div ref={ref} className="view-content oc-plugin-view" />;
}
