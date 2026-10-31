import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { VaultStore } from '../vault/VaultStore';

/**
 * The contract between the web workspace (React UI) and the Obsidian plugin
 * API shim. The UI implements `WorkspaceHost` and hands it to the PluginHost;
 * plugins register things into `pluginRegistry`, which the UI renders
 * (commands → command palette, views → panes, ribbon icons, status bar items,
 * setting tabs, editor extensions).
 */

export type ViewMode = 'source' | 'preview';

export interface WorkspaceHost {
  readonly store: VaultStore;
  /** Open a vault file in the main area. */
  openFile(path: string, opts?: { newLeaf?: boolean; mode?: ViewMode; subpath?: string }): void;
  /** Resolve + open an internal link (creates nothing if unresolved). */
  openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean): void;
  getActiveFilePath(): string | null;
  getActiveMode(): ViewMode | null;
  /** The CodeMirror view of the active note in source mode, if any. */
  getActiveEditorView(): EditorView | null;
  /** Re-render the active note's reading view (e.g. after plugin load). */
  rerenderActive(): void;
  /** Open a registered custom view type in the main area (e.g. a plugin pane). */
  openView(viewType: string, state?: Record<string, unknown>): void;
}

export interface RegisteredCommand {
  id: string; // `${pluginId}:${commandId}`
  name: string; // `${pluginName}: ${commandName}`
  icon?: string;
  hotkeys?: Array<{ modifiers: string[]; key: string }>;
  /** Returns false when the command is not available in the current state. */
  check: () => boolean;
  run: () => unknown;
}

export interface RegisteredRibbonIcon {
  id: string;
  icon: string;
  title: string;
  onClick: (ev: MouseEvent) => unknown;
}

/** A plugin view: the shim builds an Obsidian ItemView/FileView into `containerEl`. */
export interface RegisteredView {
  type: string;
  pluginId: string;
  /** Mount the view into `container`; returns an unmount function. */
  mount: (container: HTMLElement, opts: { filePath?: string; state?: Record<string, unknown> }) => () => void;
  displayText?: () => string;
}

export interface RegisteredSettingTab {
  id: string; // plugin id
  name: string;
  /** Render the tab into `container` (calls the plugin's display()); returns cleanup (hide()). */
  mount: (container: HTMLElement) => () => void;
}

export interface LoadedPluginInfo {
  id: string;
  name: string;
  version: string;
  status: 'loaded' | 'error' | 'skipped';
  error?: string;
}

type Listener = () => void;

class PluginRegistry {
  commands = new Map<string, RegisteredCommand>();
  ribbonIcons = new Map<string, RegisteredRibbonIcon>();
  statusBarItems = new Map<string, HTMLElement>();
  /** view type → view */
  views = new Map<string, RegisteredView>();
  /** file extension (no dot, lower-case) → view type */
  extensions = new Map<string, string>();
  settingTabs = new Map<string, RegisteredSettingTab>();
  /** CodeMirror 6 extensions registered by plugins (registerEditorExtension). */
  editorExtensions: Extension[] = [];
  plugins: LoadedPluginInfo[] = [];
  private listeners = new Set<Listener>();
  private version = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Notify the UI that something was (un)registered. */
  changed(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }
  getVersion(): number {
    return this.version;
  }
  clear(): void {
    this.commands.clear();
    this.ribbonIcons.clear();
    this.statusBarItems.clear();
    this.views.clear();
    this.extensions.clear();
    this.settingTabs.clear();
    this.editorExtensions = [];
    this.plugins = [];
    this.changed();
  }
}

export const pluginRegistry = new PluginRegistry();
