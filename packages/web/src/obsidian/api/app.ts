import { Component, Keymap, Scope } from './component';
import { Vault, MetadataCache, FileManager } from './files';
import { Workspace, MarkdownView, WorkspaceLeaf } from './workspace';
import { PluginSettingTab } from './ui';
import { markdownHooks, renderMarkdown, type PostProcessorContext } from '../../markdown/render';
import { pluginRegistry, type RegisteredCommand, type WorkspaceHost } from '../host';
import type { VaultStore } from '../../vault/VaultStore';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
  dir?: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  mobileOnly?: boolean;
  repeatable?: boolean;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: any, ctx: any) => unknown;
  editorCheckCallback?: (checking: boolean, editor: any, ctx: any) => boolean | void;
}

/** The `app` object plugins receive. */
export class App {
  readonly vault: Vault;
  readonly metadataCache: MetadataCache;
  readonly workspace: Workspace;
  readonly fileManager: FileManager;
  readonly keymap = { pushScope() {}, popScope() {} };
  readonly scope = new Scope();
  readonly isMobile = false;
  readonly appId: string;
  lastEvent: UIEvent | null = null;
  readonly plugins = {
    plugins: {} as Record<string, Plugin>,
    manifests: {} as Record<string, PluginManifest>,
    enabledPlugins: new Set<string>(),
    getPlugin: (id: string): Plugin | null => this.plugins.plugins[id] ?? null,
    isEnabled: (id: string): boolean => this.plugins.enabledPlugins.has(id),
  };
  readonly internalPlugins = {
    plugins: {
      bookmarks: { enabled: true, instance: { items: [] as unknown[] } },
    } as Record<string, { enabled: boolean; instance: unknown }>,
    getPluginById: (id: string) => this.internalPlugins.plugins[id] ?? null,
    getEnabledPluginById: (id: string) => {
      const p = this.internalPlugins.plugins[id];
      return p?.enabled ? p.instance : null;
    },
  };
  /** Obsidian-shaped commands by full id (plugins patch these, e.g. the
   *  Linter wraps `editor:save-file`'s checkCallback); the registry entries
   *  call through to them. */
  readonly commands = {
    commands: {} as Record<string, Command>,
    executeCommandById: (id: string): boolean => {
      const c = this.commands.commands[id];
      if (!c || !runCommand(this, c, true)) return false;
      void Promise.resolve(runCommand(this, c, false)).catch((e) => console.error(e));
      return true;
    },
    listCommands: (): Command[] => Object.values(this.commands.commands),
    findCommand: (id: string): Command | undefined => this.commands.commands[id],
  };
  readonly setting = {
    open: (): void => void window.dispatchEvent(new CustomEvent('oc:open-settings', { detail: null })),
    openTabById: (id: string): void => void window.dispatchEvent(new CustomEvent('oc:open-settings', { detail: id })),
    close: (): void => void window.dispatchEvent(new CustomEvent('oc:close-settings')),
  };
  readonly customCss = { snippets: [] as string[], enabledSnippets: new Set<string>(), theme: '' };
  readonly dom = { appContainerEl: document.body };

  constructor(
    readonly store: VaultStore,
    readonly host: WorkspaceHost,
    sessionId: string,
  ) {
    // Dataview keys its IndexedDB cache by appId. A per-session id keeps a
    // stale cache from surviving content edits made elsewhere (file mtimes
    // come from the server tree and don't change on every edit).
    this.appId = `oc-${store.vaultId}-${sessionId}`;
    this.vault = new Vault(store);
    this.metadataCache = new MetadataCache(this.vault, store);
    this.workspace = new Workspace(this, host);
    this.fileManager = new FileManager(this.vault, this.metadataCache);
  }

  loadLocalStorage(key: string): unknown {
    try {
      const v = localStorage.getItem(`oc-app-${this.store.vaultId}-${key}`);
      return v === null ? null : JSON.parse(v);
    } catch {
      return null;
    }
  }
  saveLocalStorage(key: string, data: unknown): void {
    try {
      const k = `oc-app-${this.store.vaultId}-${key}`;
      if (data === null || data === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(data));
    } catch {
      /* storage unavailable */
    }
  }
  openWithDefaultApp(_path: string): void {}
  showInFolder(_path: string): void {}
  getTheme(): 'obsidian' | 'moonstone' {
    return document.body.classList.contains('theme-dark') ? 'obsidian' : 'moonstone';
  }
}

/** A code-block processor handle (Dataview sets `.sortOrder` on it). */
type PostProcessorFn = ((el: HTMLElement, ctx: PostProcessorContext) => unknown) & { sortOrder?: number };

export class Plugin extends Component {
  /** Set by the host for unloading: cleanup of registry entries. */
  _ocCleanup: Array<() => void> = [];

  constructor(
    public app: App,
    public manifest: PluginManifest,
  ) {
    super();
  }

  async loadData(): Promise<any> {
    return this.app.store.readConfigJson(`plugins/${this.manifest.id}/data.json`);
  }
  async saveData(data: unknown): Promise<void> {
    await this.app.store.writeConfig(`plugins/${this.manifest.id}/data.json`, JSON.stringify(data, null, 2));
  }
  onExternalSettingsChange(): void {}
  onUserEnable(): void {}

  private track(cleanup: () => void): void {
    this._ocCleanup.push(cleanup);
    this.register(cleanup);
  }

  addCommand(command: Command): Command {
    const cmd = registerCommand(this.app, { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` });
    this.track(() => unregisterCommand(this.app, cmd.id));
    return cmd;
  }
  removeCommand(commandId: string): void {
    unregisterCommand(this.app, `${this.manifest.id}:${commandId}`);
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const id = `${this.manifest.id}:${title}`;
    const el = createDiv({ cls: 'side-dock-ribbon-action clickable-icon', attr: { 'aria-label': title } });
    pluginRegistry.ribbonIcons.set(id, { id, icon, title, onClick: callback });
    pluginRegistry.changed();
    this.track(() => {
      pluginRegistry.ribbonIcons.delete(id);
      pluginRegistry.changed();
    });
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const id = `${this.manifest.id}:${pluginRegistry.statusBarItems.size}:${Math.random().toString(36).slice(2)}`;
    const el = createDiv({ cls: 'status-bar-item', attr: { 'data-plugin': this.manifest.id } });
    pluginRegistry.statusBarItems.set(id, el);
    pluginRegistry.changed();
    this.track(() => {
      pluginRegistry.statusBarItems.delete(id);
      el.remove();
      pluginRegistry.changed();
    });
    return el;
  }

  addSettingTab(tab: PluginSettingTab): void {
    const id = this.manifest.id;
    pluginRegistry.settingTabs.set(id, {
      id,
      name: this.manifest.name,
      mount: (container) => {
        container.appendChild(tab.containerEl);
        try {
          tab.display();
        } catch (e) {
          tab.containerEl.createEl('pre', { cls: 'oc-plugin-error', text: String((e as Error).message ?? e) });
        }
        return () => {
          tab.hide();
          tab.containerEl.remove();
        };
      },
    });
    pluginRegistry.changed();
    this.track(() => {
      pluginRegistry.settingTabs.delete(id);
      pluginRegistry.changed();
    });
  }

  registerView(type: string, viewCreator: (leaf: any) => any): void {
    const app = this.app;
    pluginRegistry.views.set(type, {
      type,
      pluginId: this.manifest.id,
      mount: (container, opts) => {
        const leaf = new WorkspaceLeaf(app, app.host);
        const view = viewCreator(leaf);
        leaf.view = view;
        container.appendChild(view.containerEl);
        app.workspace.mounted.add(leaf);
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          app.workspace.mounted.delete(leaf);
          void Promise.resolve(view.onClose?.())
            .catch((e: unknown) => console.error(e))
            .finally(() => {
              view.unload();
              view.containerEl.remove();
            });
        };
        leaf.detachFn = close;
        void (async () => {
          try {
            view.load();
            await view.onOpen?.();
            const state = opts.filePath ? { ...(opts.state ?? {}), file: opts.filePath } : opts.state;
            if (state && Object.keys(state).length) await view.setState?.(state, { history: false });
          } catch (e) {
            view.containerEl.createEl('pre', { cls: 'oc-plugin-error', text: String((e as Error).message ?? e) });
          }
        })();
        return close;
      },
      displayText: undefined,
    });
    pluginRegistry.changed();
    this.track(() => {
      app.workspace.detachLeavesOfType(type);
      pluginRegistry.views.delete(type);
      for (const [ext, t] of pluginRegistry.extensions) if (t === type) pluginRegistry.extensions.delete(ext);
      pluginRegistry.changed();
    });
  }

  registerExtensions(extensions: string[], viewType: string): void {
    for (const ext of extensions) pluginRegistry.extensions.set(ext.toLowerCase(), viewType);
    pluginRegistry.changed();
    this.track(() => {
      for (const ext of extensions) {
        if (pluginRegistry.extensions.get(ext.toLowerCase()) === viewType) pluginRegistry.extensions.delete(ext.toLowerCase());
      }
      pluginRegistry.changed();
    });
  }

  registerMarkdownPostProcessor(postProcessor: PostProcessorFn, sortOrder?: number): PostProcessorFn {
    if (sortOrder !== undefined) postProcessor.sortOrder = sortOrder;
    // sortOrder is read lazily: Dataview assigns it after registering.
    const entry = {
      fn: (el: HTMLElement, ctx: PostProcessorContext) => postProcessor(el, ctx),
      get sortOrder() {
        return postProcessor.sortOrder ?? 0;
      },
    };
    markdownHooks.postProcessors.push(entry);
    this.track(() => {
      const i = markdownHooks.postProcessors.indexOf(entry);
      if (i >= 0) markdownHooks.postProcessors.splice(i, 1);
    });
    return postProcessor;
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    handler: (source: string, el: HTMLElement, ctx: PostProcessorContext) => unknown,
    sortOrder?: number,
  ): PostProcessorFn {
    const fn = ((source: unknown, el: unknown, ctx: unknown) =>
      handler(source as string, el as HTMLElement, ctx as PostProcessorContext)) as unknown as PostProcessorFn;
    if (sortOrder !== undefined) fn.sortOrder = sortOrder;
    markdownHooks.codeBlockProcessors.set(language, (source, el, ctx) => handler(source, el, ctx));
    this.track(() => {
      markdownHooks.codeBlockProcessors.delete(language);
    });
    return fn;
  }

  registerEditorExtension(extension: unknown): void {
    pluginRegistry.editorExtensions.push(extension as never);
    pluginRegistry.changed();
    this.track(() => {
      const i = pluginRegistry.editorExtensions.indexOf(extension as never);
      if (i >= 0) pluginRegistry.editorExtensions.splice(i, 1);
      pluginRegistry.changed();
    });
  }

  registerEditorSuggest(suggest: { trigger?: unknown; close?: () => void }): void {
    editorSuggests.add(suggest);
    this.track(() => {
      suggest.close?.();
      editorSuggests.delete(suggest);
    });
  }
  registerHoverLinkSource(_id: string, _info: unknown): void {}
  registerObsidianProtocolHandler(_action: string, _handler: unknown): void {}
  registerCliHandler(): void {}
  registerCodeMirror(_cb: unknown): void {}
}

/** Obsidian command semantics: checking=true asks availability. */
export function runCommand(app: App, c: Command, checking: boolean): unknown {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  try {
    if (c.editorCheckCallback) return view ? c.editorCheckCallback(checking, view.editor, view) : false;
    if (c.editorCallback) return checking ? !!view : view && c.editorCallback(view.editor, view);
    if (c.checkCallback) return c.checkCallback(checking);
    return checking ? !!c.callback : c.callback?.();
  } catch (e) {
    if (checking) return false;
    throw e;
  }
}

/** Add a command to app.commands + the UI registry (looked up by id at run time). */
export function registerCommand(app: App, cmd: Command): Command {
  app.commands.commands[cmd.id] = cmd;
  const reg: RegisteredCommand = {
    id: cmd.id,
    name: cmd.name,
    icon: cmd.icon,
    hotkeys: cmd.hotkeys,
    check: () => {
      const c = app.commands.commands[cmd.id];
      return !!c && !!runCommand(app, c, true);
    },
    run: () => {
      const c = app.commands.commands[cmd.id];
      return c ? runCommand(app, c, false) : undefined;
    },
  };
  pluginRegistry.commands.set(cmd.id, reg);
  pluginRegistry.changed();
  return cmd;
}
export function unregisterCommand(app: App, id: string): void {
  delete app.commands.commands[id];
  pluginRegistry.commands.delete(id);
  pluginRegistry.changed();
}

/** EditorSuggests registered by plugins (driven by PluginHost.notifyEditorChange). */
export const editorSuggests = new Set<{ trigger?: unknown; close?: () => void }>();

/** MarkdownRenderer (static API). */
export class MarkdownRenderer extends Component {
  static async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    await renderMarkdown(markdown, el, {
      store: app.store,
      sourcePath,
      addChild: (child) => component.addChild(child as Component),
    });
    // The API render puts blocks directly into `el` (Dataview relies on
    // `:scope > p`); the reading view's per-section wrapper divs are unwrapped.
    for (const div of Array.from(el.children)) {
      if (div.tagName === 'DIV' && div.attributes.length === 0) div.replaceWith(...Array.from(div.childNodes));
    }
  }
  static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    const app = currentApp;
    if (!app) return Promise.resolve();
    return MarkdownRenderer.render(app, markdown, el, sourcePath, component);
  }
}

let currentApp: App | null = null;
export function setCurrentApp(app: App | null): void {
  currentApp = app;
}
export function getCurrentApp(): App | null {
  return currentApp;
}

/** Legacy static post-processor registry. */
export const MarkdownPreviewRenderer = {
  registerPostProcessor(fn: PostProcessorFn, sortOrder?: number): void {
    markdownHooks.postProcessors.push({ fn, sortOrder: sortOrder ?? fn.sortOrder ?? 0 });
  },
  unregisterPostProcessor(fn: PostProcessorFn): void {
    const i = markdownHooks.postProcessors.findIndex((e) => e.fn === fn);
    if (i >= 0) markdownHooks.postProcessors.splice(i, 1);
  },
  createCodeBlockPostProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: PostProcessorContext) => unknown) {
    return (el: HTMLElement, ctx: PostProcessorContext) => {
      el.querySelectorAll<HTMLElement>(`pre > code.language-${language}`).forEach((code) => {
        const box = createDiv({ cls: `block-language-${language}` });
        code.parentElement!.replaceWith(box);
        void handler(code.textContent ?? '', box, ctx);
      });
    };
  },
};

export { Keymap };
