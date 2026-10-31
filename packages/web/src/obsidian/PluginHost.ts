import moment from 'moment';
import { installObsidianDom } from './dom';
import { pluginRegistry, type LoadedPluginInfo, type WorkspaceHost } from './host';
import { App, Plugin, setCurrentApp, editorSuggests, registerCommand, type PluginManifest } from './api/app';
import { MarkdownView, editorInfoField, editorLivePreviewField, setEditorInfoProvider } from './api/workspace';
import { RESOURCE_PREFIX } from './api/files';
import { pluginRequire } from './api/index';
import type { EditorSuggest } from './api/ui';

/** Never run in the browser: the sync plugin itself (it is the desktop half). */
const SKIP = new Set(['obsidian-cloud']);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Plugins still talk to CodeMirror 5 globals on load (Dataview/Templater
 * define modes + helpers, the Linter patches the vim adapter's save). There is
 * no CM5 on the web: a permissive stub absorbs those calls (any unknown member
 * is a no-op function, usable as a constructor too).
 */
function installCodeMirror5Stub(): void {
  const w = window as unknown as { CodeMirror?: unknown; CodeMirrorAdapter?: unknown };
  const noop = function () {} as unknown as object;
  const permissive = (base: Record<string, unknown>): unknown =>
    new Proxy(base, {
      get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' ? noop : undefined),
    });
  if (!w.CodeMirror) {
    const modes: Record<string, unknown> = {};
    w.CodeMirror = permissive({
      modes,
      mimeModes: {},
      defineMode: (name: string, factory: unknown) => void (modes[name] = factory),
      defineSimpleMode: (name: string, spec: unknown) => void (modes[name] = spec),
      getMode: (_config: unknown, name: string) => modes[name] ?? {},
      findModeByName: () => null,
    });
  }
  w.CodeMirrorAdapter ??= { commands: {}, Vim: permissive({}) };
}

/**
 * Loads the vault's community plugins (from its encrypted `.obsidian` config
 * folder) and runs them against the Obsidian API shim.
 *
 * Plugin code runs in the page with the same powers as in desktop Obsidian —
 * including access to the decrypted vault — so the UI asks the user to trust
 * each plugin's code hash before calling loadVaultPlugins().
 */
export class PluginHost {
  readonly app: App;
  private readonly styles = new Map<string, HTMLStyleElement>();
  private resourceObserver: MutationObserver | null = null;
  private readonly baseExtensions = [editorInfoField, editorLivePreviewField];
  private loaded: Plugin[] = [];

  constructor(private readonly host: WorkspaceHost) {
    installObsidianDom();
    installCodeMirror5Stub();
    (window as unknown as { moment: typeof moment }).moment ??= moment;
    const session = Math.random().toString(36).slice(2, 10);
    this.app = new App(host.store, host, session);
    setCurrentApp(this.app);
    // Obsidian exposes the App as a global; user scripts (dataviewjs,
    // Templater) use the bare `app` identifier.
    (window as unknown as { app: App }).app = this.app;
    this.app.workspace.onUpdateOptions = () => pluginRegistry.changed();
    // Obsidian's editor state fields must exist in every editor (plugins read them).
    pluginRegistry.editorExtensions.unshift(...this.baseExtensions);
    pluginRegistry.changed();
    this.installResourceResolver();
    // Built-in commands plugins hook into. Notes save live (CRDT), so "save"
    // itself does nothing — but the Linter's lint-on-save wraps it.
    registerCommand(this.app, {
      id: 'editor:save-file',
      name: 'Save current file',
      checkCallback: (checking) => (checking ? !!this.app.workspace.getActiveFile() : undefined),
    });
  }

  /** The enabled plugin ids, in community-plugins.json order (minus skipped ones). */
  async enabledPluginIds(): Promise<string[]> {
    // Plugin code only comes from the server-protected config folder (only
    // admins / plugin admins can change it) — never from a folder any vault
    // member could have planted.
    if (!this.host.store.configTrusted) return [];
    const list = await this.host.store.readConfigJson<unknown>('community-plugins.json');
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string' && !SKIP.has(x));
  }

  /** SHA-256 of each enabled plugin's main.js — for trust-on-first-use, before loading. */
  async pluginCodeHashes(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const id of await this.enabledPluginIds()) {
      const bytes = await this.host.store.readConfigBinary(`plugins/${id}/main.js`).catch(() => null);
      if (bytes) out[id] = await sha256Hex(bytes);
    }
    return out;
  }

  /** Manifests of the enabled plugins (for a trust prompt / settings list). */
  async pluginManifests(): Promise<PluginManifest[]> {
    const out: PluginManifest[] = [];
    for (const id of await this.enabledPluginIds()) {
      const m = await this.host.store.readConfigJson<PluginManifest>(`plugins/${id}/manifest.json`).catch(() => null);
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Load + enable the vault's plugins. `only` restricts loading to the given
   * ids (e.g. those the user trusted). Marks the workspace layout ready at the
   * end, which is when plugins like Dataview start indexing.
   */
  async loadVaultPlugins(only?: string[]): Promise<LoadedPluginInfo[]> {
    const store = this.host.store;
    await this.app.vault.loadAppConfig();
    const bookmarks = await store.readConfigJson<{ items?: unknown[] }>('bookmarks.json').catch(() => null);
    const bm = this.app.internalPlugins.plugins.bookmarks.instance as { items: unknown[] };
    bm.items = bookmarks?.items ?? [];
    await this.cleanupOldCaches();
    const notesLoaded = store.loadAllNotes().catch((e) => console.error(e));

    const results: LoadedPluginInfo[] = [];
    for (const id of await this.enabledPluginIds()) {
      if (only && !only.includes(id)) {
        results.push({ id, name: id, version: '', status: 'skipped', error: 'not trusted' });
        continue;
      }
      results.push(await this.loadOne(id));
    }
    // HTML Viewer registers html/htm only; .xhtml (e.g. unpacked EPUB
    // chapters) renders fine with the same view.
    const htmlView = pluginRegistry.extensions.get('html');
    if (htmlView && !pluginRegistry.extensions.has('xhtml')) pluginRegistry.extensions.set('xhtml', htmlView);
    pluginRegistry.plugins = results;
    pluginRegistry.changed();
    // Index-building plugins (Dataview) start on layout-ready: give the vault's
    // notes a moment to load first so the first query results are complete.
    await Promise.race([notesLoaded, new Promise((r) => setTimeout(r, 15_000))]);
    this.app.workspace.setLayoutReady();
    if (store.indexed) this.app.metadataCache.trigger('resolved');
    return results;
  }

  private async loadOne(id: string): Promise<LoadedPluginInfo> {
    const store = this.host.store;
    const manifest = await store.readConfigJson<PluginManifest>(`plugins/${id}/manifest.json`).catch(() => null);
    if (!manifest) return { id, name: id, version: '', status: 'skipped', error: 'manifest.json missing' };
    const info: LoadedPluginInfo = { id, name: manifest.name ?? id, version: manifest.version ?? '', status: 'loaded' };
    if (manifest.isDesktopOnly) return { ...info, status: 'skipped', error: 'desktop-only plugin' };
    const code = await store.readConfig(`plugins/${id}/main.js`).catch(() => null);
    if (!code) return { ...info, status: 'skipped', error: 'main.js missing' };
    manifest.dir = `.obsidian/plugins/${id}`;
    const css = await store.readConfig(`plugins/${id}/styles.css`).catch(() => null);
    if (css) {
      const style = document.createElement('style');
      style.setAttribute('data-plugin', id);
      style.textContent = css;
      document.head.appendChild(style);
      this.styles.set(id, style);
    }
    let plugin: Plugin | null = null;
    try {
      const module = { exports: {} as Record<string, unknown> };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('require', 'module', 'exports', `${code}\n//# sourceURL=plugin:${id}/main.js`);
      fn(pluginRequire, module, module.exports);
      const Ctor = (module.exports.default ?? module.exports) as new (app: App, m: PluginManifest) => Plugin;
      if (typeof Ctor !== 'function') throw new Error('main.js does not export a plugin class');
      plugin = new Ctor(this.app, manifest);
      this.app.plugins.plugins[id] = plugin;
      this.app.plugins.manifests[id] = manifest;
      this.app.plugins.enabledPlugins.add(id);
      plugin._loaded = true;
      await plugin.onload();
      for (const c of [...plugin._children]) c.load();
      this.loaded.push(plugin);
      return info;
    } catch (err) {
      console.error(`Plugin ${id} failed to load`, err);
      if (plugin) {
        try {
          plugin.unload();
        } catch {
          /* ignore */
        }
        delete this.app.plugins.plugins[id];
        this.app.plugins.enabledPlugins.delete(id);
      }
      this.styles.get(id)?.remove();
      this.styles.delete(id);
      return { ...info, status: 'error', error: String((err as Error)?.message ?? err) };
    }
  }

  async unloadAll(): Promise<void> {
    for (const p of this.loaded.splice(0).reverse()) {
      try {
        p.unload();
      } catch (e) {
        console.error(e);
      }
      delete this.app.plugins.plugins[p.manifest.id];
      this.app.plugins.enabledPlugins.delete(p.manifest.id);
    }
    for (const s of this.styles.values()) s.remove();
    this.styles.clear();
    editorSuggests.clear();
    this.resourceObserver?.disconnect();
    this.resourceObserver = null;
    this.app.vault.destroy();
    this.app.metadataCache.destroy();
    setEditorInfoProvider(null);
    setCurrentApp(null);
    const w = window as unknown as { app?: App };
    if (w.app === this.app) delete w.app;
    pluginRegistry.clear();
  }

  // ── workspace notifications from the UI ─────────────────────────────────
  notifyFileOpen(path: string | null): void {
    const file = path ? this.app.vault.getFileByPath(path) : null;
    this.app.workspace.trigger('file-open', file);
    this.app.workspace.trigger('active-leaf-change', this.app.workspace.activeLeaf);
  }
  notifyLayoutChange(): void {
    this.app.workspace.trigger('layout-change');
  }
  notifyEditorChange(): void {
    const ws = this.app.workspace;
    const view = ws.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;
    ws.trigger('editor-change', editor, view);
    for (const s of editorSuggests) {
      void (s as unknown as EditorSuggest<unknown>).trigger?.(editor, view.file);
    }
  }
  /** Forward editor keydowns so open EditorSuggest popovers get arrows/enter. Returns true if consumed. */
  handleEditorKey(ev: KeyboardEvent): boolean {
    for (const s of editorSuggests) {
      if ((s as unknown as EditorSuggest<unknown>).handleKey?.(ev)) return true;
    }
    return false;
  }
  /** Run a registered command by id (also usable for hotkeys). */
  executeCommand(id: string): boolean {
    return this.app.commands.executeCommandById(id);
  }

  // ── internals ───────────────────────────────────────────────────────────
  /** Swap `ocres:` placeholder URLs (from the sync getResourcePath) for blob: URLs. */
  private installResourceResolver(): void {
    const store = this.host.store;
    const vault = this.app.vault;
    const fix = (el: Element): void => {
      const src = el.getAttribute('src');
      if (!src?.startsWith(RESOURCE_PREFIX)) return;
      const path = decodeURIComponent(src.slice(RESOURCE_PREFIX.length));
      el.setAttribute('src', '');
      void store
        .resourceUrl(path)
        .then((url) => {
          vault.cachedUrls.set(path, url);
          el.setAttribute('src', url);
        })
        .catch(() => el.setAttribute('alt', `${path} (not available)`));
    };
    const scan = (root: ParentNode): void => {
      root.querySelectorAll?.('[src^="ocres:"]').forEach(fix);
    };
    this.resourceObserver = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') fix(r.target as Element);
        else
          r.addedNodes.forEach((n) => {
            if (n.nodeType === 1) {
              fix(n as Element);
              scan(n as Element);
            }
          });
      }
    });
    this.resourceObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    scan(document.body);
  }

  /** Drop Dataview caches of earlier sessions of this vault (they hold plaintext metadata). */
  private async cleanupOldCaches(): Promise<void> {
    const idb = globalThis.indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
    if (!idb?.databases) return;
    try {
      const prefix = `dataview/cache/oc-${this.host.store.vaultId}-`;
      for (const db of await idb.databases()) {
        if (db.name?.startsWith(prefix) && db.name !== `dataview/cache/${this.app.appId}`) idb.deleteDatabase(db.name);
      }
    } catch {
      /* best effort */
    }
  }
}
