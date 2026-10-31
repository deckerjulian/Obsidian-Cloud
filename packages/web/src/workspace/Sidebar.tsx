import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { hasCapability, type TreeNodeDto } from '@oc/shared';
import { iconSvg } from '../markdown/icons';
import { useStoreVersion } from '../vault/VaultContext';
import type { VaultStore, VEntry, VFile, VFolder } from '../vault/VaultStore';

/** Inline Lucide icon (shared with callouts and plugins). */
export function LIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <span
      className={`oc-licon${className ? ` ${className}` : ''}`}
      // Static, internal SVG strings only (no user input).
      dangerouslySetInnerHTML={{ __html: iconSvg(name, size) ?? '' }}
    />
  );
}

// ── context menu ─────────────────────────────────────────────────────────────
export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const close = (ev: MouseEvent): void => {
      if (!ref.current?.contains(ev.target as Node)) onCloseRef.current();
    };
    const esc = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onCloseRef.current();
    };
    // Register after the opening click; cancel if unmounted before that.
    const timer = setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  return (
    <div ref={ref} className="menu oc-context-menu" style={{ left: x, top: y }}>
      {items.map((it) => (
        <div
          key={it.label}
          className={`menu-item${it.danger ? ' is-warning' : ''}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.icon && <LIcon name={it.icon} size={15} className="menu-item-icon" />}
          <span className="menu-item-title">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── file explorer ────────────────────────────────────────────────────────────
const sortEntries = (a: VEntry, b: VEntry): number =>
  a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true });

export function VaultExplorer({
  store,
  activePath,
  onOpen,
  onShare,
  onError,
}: {
  store: VaultStore;
  activePath: string | null;
  onOpen: (path: string, newLeaf: boolean) => void;
  onShare: (node: TreeNodeDto) => void;
  onError: (msg: string) => void;
}) {
  useStoreVersion(store, ['tree']);
  const storageKey = `oc.expanded.${store.vaultId}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const [menu, setMenu] = useState<{ x: number; y: number; entry: VEntry | null } | null>(null);
  useEffect(() => localStorage.setItem(storageKey, JSON.stringify([...expanded])), [expanded, storageKey]);

  // Reveal the active file's folders.
  useEffect(() => {
    if (!activePath) return;
    const parts = activePath.split('/');
    if (parts.length < 2) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activePath]);

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const run = (p: Promise<unknown>): void => {
    p.catch((e) => onError((e as Error).message));
  };
  const newNote = (folder: string): void => {
    const name = window.prompt('Name der neuen Notiz', 'Unbenannt');
    if (!name) return;
    const path = `${folder ? `${folder}/` : ''}${name.endsWith('.md') ? name : `${name}.md`}`;
    run(store.create(path, '').then(() => onOpen(path, false)));
  };
  const newFolder = (folder: string): void => {
    const name = window.prompt('Name des neuen Ordners', 'Neuer Ordner');
    if (!name) return;
    run(store.createFolder(`${folder ? `${folder}/` : ''}${name}`));
  };
  const menuItems = (entry: VEntry | null): MenuItem[] => {
    const folder = entry === null ? '' : entry.kind === 'folder' ? entry.path : entry.parentPath;
    const items: MenuItem[] = [
      { label: 'Neue Notiz', icon: 'file-plus', onClick: () => newNote(folder) },
      { label: 'Neuer Ordner', icon: 'folder-plus', onClick: () => newFolder(folder) },
    ];
    if (!entry?.node) return items;
    const node = entry.node;
    if (entry.kind === 'file') items.unshift({ label: 'In neuem Tab öffnen', icon: 'external-link', onClick: () => onOpen(entry.path, true) });
    if (hasCapability(node.capabilities, 'edit')) {
      items.push({
        label: 'Umbenennen',
        icon: 'pencil',
        onClick: () => {
          const next = window.prompt('Neuer Name', entry.name);
          if (next && next !== entry.name) run(store.rename(entry.path, `${entry.parentPath ? `${entry.parentPath}/` : ''}${next}`));
        },
      });
    }
    if (hasCapability(node.capabilities, 'share')) items.push({ label: 'Teilen…', icon: 'link', onClick: () => onShare(node) });
    if (hasCapability(node.capabilities, 'delete')) {
      items.push({
        label: 'Löschen',
        icon: 'trash',
        danger: true,
        onClick: () => {
          if (window.confirm(`„${entry.name}“ ${entry.kind === 'folder' ? 'samt Inhalt ' : ''}löschen?`)) run(store.delete(entry.path));
        },
      });
    }
    return items;
  };
  const openMenu = (ev: ReactMouseEvent, entry: VEntry | null): void => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  };

  const renderFolder = (folder: VFolder, depth: number): ReactElement[] =>
    [...folder.children].sort(sortEntries).flatMap((e) => {
      const pad = { paddingLeft: 8 + depth * 14 };
      if (e.kind === 'folder') {
        const open = expanded.has(e.path);
        return [
          <div
            key={`d:${e.path}`}
            className={`tree-item-self nav-folder-title is-clickable${open ? '' : ' is-collapsed'}`}
            style={pad}
            onClick={() => toggle(e.path)}
            onContextMenu={(ev) => openMenu(ev, e)}
            title={e.path}
          >
            <LIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="tree-item-icon collapse-icon" />
            <span className="tree-item-inner nav-folder-title-content">{e.name}</span>
          </div>,
          ...(open ? renderFolder(e, depth + 1) : []),
        ];
      }
      const isMd = e.extension === 'md';
      return [
        <div
          key={`f:${e.path}`}
          className={`tree-item-self nav-file-title is-clickable${e.path === activePath ? ' is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 + 18 }}
          onClick={(ev) => onOpen(e.path, ev.metaKey || ev.ctrlKey)}
          onAuxClick={(ev) => ev.button === 1 && onOpen(e.path, true)}
          onContextMenu={(ev) => openMenu(ev, e)}
          title={e.path}
        >
          <span className="tree-item-inner nav-file-title-content">{isMd ? e.basename : e.basename}</span>
          {!isMd && <span className="nav-file-tag">{e.extension}</span>}
        </div>,
      ];
    });

  return (
    <div className="nav-files-container oc-explorer" onContextMenu={(ev) => openMenu(ev, null)}>
      <div className="nav-header">
        <div className="nav-buttons-container">
          <button className="clickable-icon nav-action-button" title="Neue Notiz" onClick={() => newNote('')}>
            <LIcon name="file-plus" size={16} />
          </button>
          <button className="clickable-icon nav-action-button" title="Neuer Ordner" onClick={() => newFolder('')}>
            <LIcon name="folder-plus" size={16} />
          </button>
          <button className="clickable-icon nav-action-button" title="Alle einklappen" onClick={() => setExpanded(new Set())}>
            <LIcon name="chevron-right" size={16} />
          </button>
        </div>
      </div>
      <div className="oc-explorer-tree">{renderFolder(store.root, 0)}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ── search ───────────────────────────────────────────────────────────────────
interface Hit {
  file: VFile;
  snippets: Array<{ before: string; match: string; after: string; line: number }>;
  nameHit: boolean;
}

/** Obsidian-ish query: words AND-ed; `tag:#x`, `path:foo`, `file:bar`, "quoted phrases". */
function runSearch(store: VaultStore, query: string): Hit[] {
  const tokens = query.match(/(?:[^\s"]+:)?"[^"]*"|\S+/g) ?? [];
  const words: string[] = [];
  const tags: string[] = [];
  const pathF: string[] = [];
  const fileF: string[] = [];
  for (const tok of tokens) {
    const m = /^(tag|path|file):(.*)$/.exec(tok);
    const val = (m ? m[2] : tok).replace(/^"|"$/g, '').toLowerCase();
    if (!val) continue;
    if (m?.[1] === 'tag') tags.push(val.startsWith('#') ? val : `#${val}`);
    else if (m?.[1] === 'path') pathF.push(val);
    else if (m?.[1] === 'file') fileF.push(val);
    else words.push(val);
  }
  if (!words.length && !tags.length && !pathF.length && !fileF.length) return [];
  const hits: Hit[] = [];
  for (const file of store.getFiles()) {
    const pathL = file.path.toLowerCase();
    if (pathF.some((p) => !pathL.includes(p))) continue;
    if (fileF.some((f) => !file.name.toLowerCase().includes(f))) continue;
    if (tags.length) {
      const cache = store.getFileCache(file.path);
      const all = new Set<string>([
        ...(cache?.tags ?? []).map((t) => t.tag.toLowerCase()),
        ...((): string[] => {
          const fm = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
          const list = Array.isArray(fm) ? fm : typeof fm === 'string' ? fm.split(/[,\s]+/) : [];
          return list.map((t) => `#${String(t).replace(/^#/, '')}`.toLowerCase());
        })(),
      ]);
      if (!tags.every((t) => [...all].some((x) => x === t || x.startsWith(`${t}/`)))) continue;
    }
    const text = store.cachedText(file.path) ?? '';
    const lower = text.toLowerCase();
    const nameHit = words.every((w) => file.basename.toLowerCase().includes(w));
    if (words.length && !nameHit && !words.every((w) => lower.includes(w))) continue;
    const snippets: Hit['snippets'] = [];
    if (words.length) {
      const w = words[0];
      let from = 0;
      while (snippets.length < 3) {
        const i = lower.indexOf(w, from);
        if (i < 0) break;
        const ls = text.lastIndexOf('\n', i) + 1;
        let le = text.indexOf('\n', i);
        if (le < 0) le = text.length;
        const start = Math.max(ls, i - 60);
        const end = Math.min(le, i + w.length + 80);
        snippets.push({
          before: (start > ls ? '…' : '') + text.slice(start, i),
          match: text.slice(i, i + w.length),
          after: text.slice(i + w.length, end) + (end < le ? '…' : ''),
          line: text.slice(0, i).split('\n').length - 1,
        });
        from = le + 1;
      }
    }
    hits.push({ file, snippets, nameHit });
  }
  return hits.sort((a, b) => Number(b.nameHit) - Number(a.nameHit) || a.file.path.localeCompare(b.file.path)).slice(0, 200);
}

export function SearchPanel({
  store,
  initialQuery,
  onOpen,
}: {
  store: VaultStore;
  initialQuery: string;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const version = useStoreVersion(store);
  useEffect(() => setQ(initialQuery), [initialQuery]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hits = useMemo(() => runSearch(store, debounced), [store, debounced, version]);
  return (
    <div className="oc-search-panel">
      <div className="search-input-container">
        <input
          autoFocus
          type="search"
          placeholder="Suchen… (tag:#x, path:, file:)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {!store.indexed && <div className="oc-faint oc-pad">Index wird aufgebaut…</div>}
      {debounced && <div className="search-result-count oc-faint oc-pad">{hits.length} Treffer</div>}
      <div className="search-results-children">
        {hits.map((h) => (
          <div key={h.file.path} className="tree-item search-result">
            <div className="tree-item-self search-result-file-title is-clickable" onClick={() => onOpen(h.file.path)}>
              <span className="tree-item-inner">{h.file.basename}</span>
              <span className="oc-faint oc-search-path">{h.file.parentPath}</span>
            </div>
            {h.snippets.map((s, i) => (
              <div key={i} className="search-result-file-match" onClick={() => onOpen(h.file.path)}>
                {s.before}
                <span className="search-result-file-matched-text">{s.match}</span>
                {s.after}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── bookmarks (.obsidian/bookmarks.json) ─────────────────────────────────────
interface BookmarkItem {
  type: 'file' | 'folder' | 'group' | 'search' | 'heading' | 'block' | 'url';
  title?: string;
  path?: string;
  subpath?: string;
  query?: string;
  url?: string;
  items?: BookmarkItem[];
}
export function BookmarksPanel({
  store,
  onOpen,
  onSearch,
}: {
  store: VaultStore;
  onOpen: (path: string, subpath?: string) => void;
  onSearch: (q: string) => void;
}) {
  const [items, setItems] = useState<BookmarkItem[] | null>(null);
  useEffect(() => {
    void store.readConfigJson<{ items?: BookmarkItem[] }>('bookmarks.json').then((b) => setItems(b?.items ?? []));
  }, [store]);
  const render = (list: BookmarkItem[], depth: number): ReactElement[] =>
    list.map((it, i) => {
      const label = it.title || it.path?.replace(/\.md$/, '').split('/').pop() || it.query || it.url || '…';
      const pad = { paddingLeft: 8 + depth * 14 };
      if (it.type === 'group') {
        return (
          <div key={i}>
            <div className="tree-item-self oc-bookmark-group" style={pad}>
              <LIcon name="folder" size={14} /> {label}
            </div>
            {render(it.items ?? [], depth + 1)}
          </div>
        );
      }
      const click = (): void => {
        if (it.type === 'search' && it.query) onSearch(it.query);
        else if (it.type === 'url' && it.url) window.open(it.url, '_blank', 'noopener');
        else if (it.path) onOpen(it.path, it.subpath);
      };
      return (
        <div key={i} className="tree-item-self is-clickable" style={pad} onClick={click}>
          <LIcon name={it.type === 'search' ? 'search' : it.type === 'folder' ? 'folder' : 'file-text'} size={14} />{' '}
          {label}
        </div>
      );
    });
  if (items === null) return <div className="oc-faint oc-pad">Lade…</div>;
  if (items.length === 0) return <div className="oc-faint oc-pad">Keine Lesezeichen in diesem Vault.</div>;
  return <div className="oc-bookmarks">{render(items, 0)}</div>;
}

// ── outline / backlinks (right sidebar) ──────────────────────────────────────
export function OutlinePanel({ store, path, onJump }: { store: VaultStore; path: string | null; onJump: (heading: string) => void }) {
  useStoreVersion(store, ['changed', 'tree']);
  const headings = path ? (store.getFileCache(path)?.headings ?? []) : [];
  if (!path) return <div className="oc-faint oc-pad">Keine Notiz geöffnet.</div>;
  if (headings.length === 0) return <div className="oc-faint oc-pad">Keine Überschriften.</div>;
  const min = Math.min(...headings.map((h) => h.level));
  return (
    <div className="oc-outline">
      {headings.map((h, i) => (
        <div
          key={i}
          className="tree-item-self is-clickable"
          style={{ paddingLeft: 8 + (h.level - min) * 14 }}
          onClick={() => onJump(h.heading)}
        >
          {h.heading}
        </div>
      ))}
    </div>
  );
}

export function BacklinksPanel({ store, path, onOpen }: { store: VaultStore; path: string | null; onOpen: (path: string) => void }) {
  useStoreVersion(store, ['resolved', 'tree']);
  if (!path) return <div className="oc-faint oc-pad">Keine Notiz geöffnet.</div>;
  const back = store.backlinks(path);
  const out = Object.keys(store.resolvedLinks[path] ?? {});
  const unresolved = Object.keys(store.unresolvedLinks[path] ?? {});
  const name = (p: string): string => p.replace(/\.md$/, '').split('/').pop() ?? p;
  return (
    <div className="oc-backlinks">
      <div className="oc-panel-subtitle">Verlinkt von ({back.length})</div>
      {back.length === 0 && <div className="oc-faint oc-pad">Keine Backlinks.</div>}
      {back.map((b) => (
        <div key={b.source} className="tree-item-self is-clickable" onClick={() => onOpen(b.source)} title={b.source}>
          {name(b.source)} <span className="oc-faint">{b.count > 1 ? `×${b.count}` : ''}</span>
        </div>
      ))}
      <div className="oc-panel-subtitle">Ausgehende Links ({out.length + unresolved.length})</div>
      {out.map((p) => (
        <div key={p} className="tree-item-self is-clickable" onClick={() => onOpen(p)} title={p}>
          {name(p)}
        </div>
      ))}
      {unresolved.map((p) => (
        <div key={`u:${p}`} className="tree-item-self oc-faint" title="Nicht aufgelöst">
          {p}
        </div>
      ))}
    </div>
  );
}
