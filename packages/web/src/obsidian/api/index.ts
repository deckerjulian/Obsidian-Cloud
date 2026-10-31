import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as cmLanguage from '@codemirror/language';
import * as cmCommands from '@codemirror/commands';
import * as component from './component';
import * as files from './files';
import * as ui from './ui';
import * as util from './util';
import * as workspace from './workspace';
import * as app from './app';

/**
 * The `obsidian` module as plugins see it via `require('obsidian')`.
 * Everything is a plain object property so CommonJS interop (`__toESM`,
 * `obsidian.X`, destructuring) all work.
 */
export const obsidianModule: Record<string, unknown> = {
  // lifecycle / events
  Component: component.Component,
  Events: component.Events,
  MarkdownRenderChild: component.MarkdownRenderChild,
  Scope: component.Scope,
  Keymap: component.Keymap,
  // files
  TAbstractFile: files.TAbstractFile,
  TFile: files.TFile,
  TFolder: files.TFolder,
  Vault: files.Vault,
  DataAdapter: files.DataAdapter,
  FileSystemAdapter: files.FileSystemAdapter,
  MetadataCache: files.MetadataCache,
  FileManager: files.FileManager,
  // app / plugin
  App: app.App,
  Plugin: app.Plugin,
  MarkdownRenderer: app.MarkdownRenderer,
  MarkdownPreviewRenderer: app.MarkdownPreviewRenderer,
  // workspace
  Workspace: workspace.Workspace,
  WorkspaceLeaf: workspace.WorkspaceLeaf,
  View: workspace.View,
  ItemView: workspace.ItemView,
  FileView: workspace.FileView,
  TextFileView: workspace.TextFileView,
  EditableFileView: workspace.TextFileView,
  MarkdownView: workspace.MarkdownView,
  MarkdownPreviewView: workspace.MarkdownView,
  Editor: workspace.Editor,
  editorInfoField: workspace.editorInfoField,
  editorLivePreviewField: workspace.editorLivePreviewField,
  editorEditorField: workspace.editorEditorField,
  editorViewField: workspace.editorViewField,
  livePreviewState: workspace.livePreviewState,
  // ui
  Notice: ui.Notice,
  Modal: ui.Modal,
  ConfirmationModal: ui.ConfirmationModal,
  Menu: ui.Menu,
  MenuItem: ui.MenuItem,
  Setting: ui.Setting,
  SettingGroup: ui.SettingGroup,
  SettingTab: ui.SettingTab,
  PluginSettingTab: ui.PluginSettingTab,
  SettingPage: ui.SettingPage,
  BaseComponent: ui.BaseComponent,
  ValueComponent: ui.ValueComponent,
  ButtonComponent: ui.ButtonComponent,
  ExtraButtonComponent: ui.ExtraButtonComponent,
  ToggleComponent: ui.ToggleComponent,
  AbstractTextComponent: ui.AbstractTextComponent,
  TextComponent: ui.TextComponent,
  SearchComponent: ui.SearchComponent,
  TextAreaComponent: ui.TextAreaComponent,
  MomentFormatComponent: ui.MomentFormatComponent,
  DropdownComponent: ui.DropdownComponent,
  SliderComponent: ui.SliderComponent,
  ColorComponent: ui.ColorComponent,
  ProgressBarComponent: ui.ProgressBarComponent,
  SuggestModal: ui.SuggestModal,
  FuzzySuggestModal: ui.FuzzySuggestModal,
  PopoverSuggest: ui.PopoverSuggest,
  AbstractInputSuggest: ui.AbstractInputSuggest,
  EditorSuggest: ui.EditorSuggest,
  HoverPopover: ui.HoverPopover,
  // functions / constants
  ...util,
  // CodeMirror passthrough (some plugins import these from 'obsidian' too)
  EditorSelection: cmState.EditorSelection,
};

/** Modules served to plugin code via `require()`. */
const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in the web app`);
};
const nodeStubs: Record<string, unknown> = {
  child_process: {
    exec: unavailable('child_process.exec'),
    execFile: unavailable('child_process.execFile'),
    spawn: unavailable('child_process.spawn'),
    execSync: unavailable('child_process.execSync'),
  },
  util: {
    promisify:
      (fn: (...a: unknown[]) => unknown) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          try {
            fn(...args, (err: unknown, res: unknown) => (err ? reject(err) : resolve(res)));
          } catch (e) {
            reject(e);
          }
        }),
    inherits: (ctor: { prototype: object }, superCtor: { prototype: object }) => {
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    },
    format: (...a: unknown[]) => a.map(String).join(' '),
    TextDecoder,
    TextEncoder,
    types: {},
  },
  fs: { promises: {}, existsSync: () => false, readFileSync: unavailable('fs') },
  path: {
    sep: '/',
    join: (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/'),
    basename: (p: string, ext?: string) => {
      const b = p.slice(p.lastIndexOf('/') + 1);
      return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
    },
    dirname: (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'),
    extname: (p: string) => {
      const b = p.slice(p.lastIndexOf('/') + 1);
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
    resolve: (...p: string[]) => p.join('/'),
    normalize: (p: string) => p,
    isAbsolute: (p: string) => p.startsWith('/'),
    relative: (_a: string, b: string) => b,
  },
  os: { platform: () => 'browser', homedir: () => '/', tmpdir: () => '/tmp', EOL: '\n' },
  crypto: globalThis.crypto,
  electron: { remote: null, shell: { openExternal: (u: string) => window.open(u, '_blank', 'noopener') } },
};

/** Obsidian ships a patched @codemirror/language that also exports
 *  `tokenClassNodeProp` (its Markdown token classes). Plugins (Dataview's
 *  live-preview renderer) read it from the syntax tree; ours has no such
 *  tokens, so a fresh, never-set NodeProp makes those lookups no-ops. */
const tokenClassNodeProp = new (
  (cmLanguage.indentNodeProp as unknown as { constructor: new () => unknown }).constructor
)();
const cmLanguageCompat = { ...cmLanguage, tokenClassNodeProp };

export const pluginModules: Record<string, unknown> = {
  obsidian: obsidianModule,
  '@codemirror/state': cmState,
  '@codemirror/view': cmView,
  '@codemirror/language': cmLanguageCompat,
  '@codemirror/commands': cmCommands,
  moment: util.moment,
  ...nodeStubs,
};

export function pluginRequire(name: string): unknown {
  const n = name.replace(/^node:/, '');
  if (n in pluginModules) return pluginModules[n];
  throw new Error(`Cannot find module '${name}' (not available in the web app)`);
}
