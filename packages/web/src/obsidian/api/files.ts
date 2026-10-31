import { Events } from './component';
import { CONFIG_DIR, type VaultStore, type VFile, type VFolder } from '../../vault/VaultStore';
import type { CachedMetadata } from '../../vault/metadata';
import { normalizePath, parseYaml, stringifyYaml, getFrontMatterInfo } from './util';

/**
 * Obsidian's file model (TAbstractFile/TFile/TFolder), `Vault`, `DataAdapter`,
 * `MetadataCache` and `FileManager`, backed by the decrypted VaultStore.
 * TFile/TFolder objects are identity-stable per server node (Dataview and
 * others keep them in maps), and are updated in place on renames.
 */

export abstract class TAbstractFile {
  vault!: Vault;
  path = '';
  name = '';
  parent: TFolder | null = null;
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export class TFile extends TAbstractFile {
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
  basename = '';
  extension = '';
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '/';
  }
}

const isConfigPath = (p: string): boolean => p === CONFIG_DIR || p.startsWith(`${CONFIG_DIR}/`);
const configRel = (p: string): string => p.slice(CONFIG_DIR.length + 1);
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const toBuf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

/** Placeholder resource URLs resolved asynchronously (see installResourceResolver). */
export const RESOURCE_PREFIX = 'ocres:';

export class Vault extends Events {
  readonly configDir = CONFIG_DIR;
  readonly adapter: DataAdapter;
  private readonly root: TFolder;
  private byNode = new Map<string, TAbstractFile>(); // node id → object
  private byPath = new Map<string, TAbstractFile>();
  private appConfig: Record<string, unknown> = {};
  private unsub: Array<() => void> = [];

  constructor(readonly store: VaultStore) {
    super();
    this.root = new TFolder();
    this.root.vault = this;
    this.root.path = '/';
    this.root.name = '';
    this.adapter = new DataAdapter(this);
    this.sync();
    const on = (name: string, fn: (...a: any[]) => void): void => {
      const ref = store.on(name, fn);
      this.unsub.push(() => store.offref(ref));
    };
    on('delete', (f: VFile) => {
      const tf = this.byNode.get(f.node.id);
      this.sync();
      if (tf) this.trigger('delete', tf);
    });
    on('rename', (f: VFile, oldPath: string) => {
      this.sync();
      const tf = f ? this.byNode.get(f.node.id) : null;
      if (tf) this.trigger('rename', tf, oldPath);
    });
    on('create', (f: VFile) => {
      this.sync();
      const tf = this.byNode.get(f.node.id);
      if (tf) this.trigger('create', tf);
    });
    on('modify', (f: VFile) => {
      const tf = this.byNode.get(f.node.id) as TFile | undefined;
      if (tf) {
        tf.stat = f.stat;
        this.trigger('modify', tf);
      }
    });
    on('tree', () => this.sync());
  }

  /** Rebuild the TFile/TFolder graph from the store, keeping identities. */
  sync(): void {
    const seen = new Set<string>();
    const byPath = new Map<string, TAbstractFile>([['/', this.root]]);
    this.root.children = [];
    const folders = this.store.getFolders().filter((f) => f.path !== '').sort((a, b) => a.path.length - b.path.length);
    const place = (obj: TAbstractFile, parentPath: string): void => {
      const parent = (parentPath === '' ? this.root : byPath.get(parentPath)) as TFolder | undefined;
      obj.parent = parent ?? this.root;
      obj.parent.children.push(obj);
    };
    for (const vf of folders) {
      const id = vf.node!.id;
      let tf = this.byNode.get(id) as TFolder | undefined;
      if (!tf || !(tf instanceof TFolder)) {
        tf = new TFolder();
        tf.vault = this;
        this.byNode.set(id, tf);
      }
      tf.path = vf.path;
      tf.name = vf.name;
      tf.children = [];
      byPath.set(vf.path, tf);
      seen.add(id);
    }
    for (const vf of folders) place(byPath.get(vf.path)!, vf.parentPath);
    for (const f of this.store.getFiles()) {
      const id = f.node.id;
      let tf = this.byNode.get(id) as TFile | undefined;
      if (!tf || !(tf instanceof TFile)) {
        tf = new TFile();
        tf.vault = this;
        this.byNode.set(id, tf);
      }
      tf.path = f.path;
      tf.name = f.name;
      tf.basename = f.basename;
      tf.extension = f.extension;
      tf.stat = f.stat;
      byPath.set(f.path, tf);
      seen.add(id);
      place(tf, f.parentPath);
    }
    for (const id of [...this.byNode.keys()]) if (!seen.has(id)) this.byNode.delete(id);
    this.byPath = byPath;
  }

  destroy(): void {
    for (const u of this.unsub.splice(0)) u();
  }

  /** Load `.obsidian/app.json` for getConfig(). */
  async loadAppConfig(): Promise<void> {
    this.appConfig = (await this.store.readConfigJson<Record<string, unknown>>('app.json')) ?? {};
  }
  getConfig(key: string): unknown {
    return this.appConfig[key];
  }
  setConfig(key: string, value: unknown): void {
    this.appConfig[key] = value;
  }

  getName(): string {
    return this.store.vaultName;
  }
  getRoot(): TFolder {
    return this.root;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    return this.byPath.get(p) ?? null;
  }
  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }
  getFiles(): TFile[] {
    return [...this.byPath.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.byPath.values()];
  }
  getAllFolders(includeRoot = false): TFolder[] {
    return [...this.byPath.values()].filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()));
  }
  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => unknown): void {
    const stack: TAbstractFile[] = [root];
    while (stack.length) {
      const f = stack.pop()!;
      cb(f);
      if (f instanceof TFolder) stack.push(...f.children);
    }
  }

  read(file: TFile): Promise<string> {
    return this.store.read(file.path);
  }
  async cachedRead(file: TFile): Promise<string> {
    return this.store.cachedText(file.path) ?? this.store.read(file.path);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return toBuf(await this.store.readBinary(file.path));
  }
  async modify(file: TFile, data: string): Promise<void> {
    await this.store.write(file.path, data);
  }
  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    await this.store.writeBinary(file.path, new Uint8Array(data));
  }
  async append(file: TFile, data: string): Promise<void> {
    await this.store.write(file.path, (await this.read(file)) + data);
  }
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(file));
    await this.modify(file, next);
    return next;
  }
  async create(path: string, data: string): Promise<TFile> {
    const p = normalizePath(path);
    await this.store.create(p, data);
    this.sync();
    const f = this.getFileByPath(p);
    if (!f) throw new Error(`Could not create ${p}`);
    return f;
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    const p = normalizePath(path);
    await this.store.create(p, new Uint8Array(data));
    this.sync();
    const f = this.getFileByPath(p);
    if (!f) throw new Error(`Could not create ${p}`);
    return f;
  }
  async createFolder(path: string): Promise<TFolder> {
    const p = normalizePath(path);
    if (this.getFolderByPath(p)) throw new Error('Folder already exists.');
    await this.store.createFolder(p);
    this.sync();
    return this.getFolderByPath(p)!;
  }
  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    await this.store.delete(file.path);
    this.sync();
  }
  async trash(file: TAbstractFile, _system?: boolean): Promise<void> {
    await this.delete(file);
  }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    await this.store.rename(file.path, normalizePath(newPath));
    this.sync();
  }
  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    if (!(file instanceof TFile)) throw new Error('Copying folders is not supported');
    const data = file.extension === 'md' ? await this.read(file) : new Uint8Array(await this.readBinary(file));
    await this.store.create(normalizePath(newPath), data);
    this.sync();
    return this.getAbstractFileByPath(newPath) as T;
  }

  /** Synchronous resource URL: the cached blob: URL if any, else a placeholder
   *  resolved in the DOM by installResourceResolver(). */
  getResourcePath(file: TFile): string {
    return this.resourceFor(file.path);
  }
  resourceFor(path: string): string {
    const cached = this.cachedUrls.get(path);
    if (cached) return cached;
    void this.store.resourceUrl(path).then((u) => this.cachedUrls.set(path, u)).catch(() => undefined);
    return `${RESOURCE_PREFIX}${encodeURIComponent(path)}`;
  }
  readonly cachedUrls = new Map<string, string>();
}

/**
 * `vault.adapter`: path-based access, including the hidden config dir
 * (`.obsidian/…`, stored in the vault's encrypted config folder).
 */
export class DataAdapter {
  constructor(private readonly vault: Vault) {}
  private get store(): VaultStore {
    return this.vault.store;
  }
  getName(): string {
    return this.vault.getName();
  }
  async exists(path: string, _sensitive?: boolean): Promise<boolean> {
    const p = normalizePath(path);
    if (p === '/') return true;
    if (isConfigPath(p)) {
      if (p === CONFIG_DIR) return true;
      const rel = configRel(p);
      return this.store.hasConfig(rel) || this.store.configFiles().some((f) => f.startsWith(`${rel}/`));
    }
    return this.store.getEntry(p) !== null;
  }
  async stat(path: string): Promise<{ type: 'file' | 'folder'; ctime: number; mtime: number; size: number } | null> {
    const p = normalizePath(path);
    if (isConfigPath(p)) {
      if (!(await this.exists(p))) return null;
      return { type: this.store.hasConfig(configRel(p)) ? 'file' : 'folder', ctime: 0, mtime: 0, size: 0 };
    }
    const e = this.store.getEntry(p === '/' ? '' : p);
    if (!e) return null;
    return e.kind === 'file' ? { type: 'file', ...e.stat } : { type: 'folder', ctime: 0, mtime: 0, size: 0 };
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const p = normalizePath(path);
    const files = new Set<string>();
    const folders = new Set<string>();
    if (isConfigPath(p)) {
      const rel = p === CONFIG_DIR ? '' : configRel(p);
      const prefix = rel ? `${rel}/` : '';
      for (const f of this.store.configFiles()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const seg = rest.split('/')[0];
        const full = `${CONFIG_DIR}/${prefix}${seg}`;
        if (rest.includes('/')) folders.add(full);
        else files.add(full);
      }
    } else {
      const folder = this.store.getFolder(p === '/' ? '' : p);
      for (const c of folder?.children ?? []) (c.kind === 'file' ? files : folders).add(c.path);
      if (p === '/') folders.add(CONFIG_DIR);
    }
    return { files: [...files], folders: [...folders] };
  }
  async read(path: string): Promise<string> {
    const p = normalizePath(path);
    if (isConfigPath(p)) {
      const t = await this.store.readConfig(configRel(p));
      if (t === null) throw new Error(`ENOENT: ${p}`);
      return t;
    }
    return this.store.read(p);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const p = normalizePath(path);
    if (isConfigPath(p)) {
      const b = await this.store.readConfigBinary(configRel(p));
      if (!b) throw new Error(`ENOENT: ${p}`);
      return toBuf(b);
    }
    return toBuf(await this.store.readBinary(p));
  }
  async write(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    if (isConfigPath(p)) return this.store.writeConfig(configRel(p), data);
    if (this.store.getFile(p)) await this.store.write(p, data);
    else await this.store.create(p, data);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const p = normalizePath(path);
    if (isConfigPath(p)) return this.store.writeConfig(configRel(p), new TextDecoder().decode(data));
    if (this.store.getFile(p)) await this.store.writeBinary(p, new Uint8Array(data));
    else await this.store.create(p, new Uint8Array(data));
  }
  async append(path: string, data: string): Promise<void> {
    const cur = (await this.exists(path)) ? await this.read(path) : '';
    await this.write(path, cur + data);
  }
  async process(path: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    await this.write(path, next);
    return next;
  }
  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (isConfigPath(p)) return; // config folders are created on first write
    if (!this.store.getFolder(p)) await this.store.createFolder(p);
  }
  async remove(path: string): Promise<void> {
    const p = normalizePath(path);
    if (isConfigPath(p)) return; // never delete config from the web
    await this.store.delete(p);
  }
  async rmdir(path: string, _recursive: boolean): Promise<void> {
    await this.remove(path);
  }
  async trashSystem(path: string): Promise<boolean> {
    await this.remove(path);
    return true;
  }
  async trashLocal(path: string): Promise<void> {
    await this.remove(path);
  }
  async rename(path: string, newPath: string): Promise<void> {
    await this.store.rename(normalizePath(path), normalizePath(newPath));
  }
  async copy(path: string, newPath: string): Promise<void> {
    await this.writeBinary(newPath, await this.readBinary(path));
  }
  getResourcePath(path: string): string {
    return this.vault.resourceFor(normalizePath(path));
  }
}

/** Marker class: `adapter instanceof FileSystemAdapter` is false on the web. */
export class FileSystemAdapter {
  getBasePath(): string {
    return '';
  }
}

export class MetadataCache extends Events {
  private unsub: Array<() => void> = [];

  constructor(
    private readonly vault: Vault,
    private readonly store: VaultStore,
  ) {
    super();
    const changed = store.on('changed', (f: VFile, text: string, cache: CachedMetadata) => {
      const tf = vault.getFileByPath(f.path);
      if (!tf) return;
      this.trigger('changed', tf, text, cache);
      // Obsidian resolves links right after; Dataview reindexes on 'resolve'.
      this.trigger('resolve', tf);
    });
    const resolved = store.on('resolved', () => this.trigger('resolved'));
    const deleted = store.on('delete', (f: VFile) => this.trigger('deleted', f, null));
    this.unsub.push(() => store.offref(changed), () => store.offref(resolved), () => store.offref(deleted));
  }
  destroy(): void {
    for (const u of this.unsub.splice(0)) u();
  }
  get resolved(): boolean {
    return this.store.indexed;
  }
  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.store.resolvedLinks;
  }
  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.store.unresolvedLinks;
  }
  getFileCache(file: TFile | null): CachedMetadata | null {
    return file ? this.store.getFileCache(file.path) : null;
  }
  getCache(path: string): CachedMetadata | null {
    return this.store.getFileCache(normalizePath(path));
  }
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const f = this.store.resolveLink(linkpath, sourcePath);
    return f ? this.vault.getFileByPath(f.path) : null;
  }
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const name = file.extension === 'md' && omitMdExtension ? file.basename : file.name;
    const resolved = this.store.resolveLink(name, sourcePath);
    if (resolved?.path === file.path) return name;
    return file.extension === 'md' && omitMdExtension ? file.path.replace(/\.md$/, '') : file.path;
  }
  getTags(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of this.store.getMarkdownFiles()) {
      for (const t of this.store.getFileCache(f.path)?.tags ?? []) out[t.tag] = (out[t.tag] ?? 0) + 1;
    }
    return out;
  }
  getLinkSuggestions(): Array<{ file: TFile | null; path: string }> {
    return this.vault.getFiles().map((f) => ({ file: f, path: f.path }));
  }
  getBacklinksForFile(file: TFile): { data: Map<string, unknown[]> } {
    const data = new Map<string, unknown[]>();
    for (const b of this.store.backlinks(file.path)) data.set(b.source, new Array(b.count).fill({}));
    return { data };
  }
}

export class FileManager {
  constructor(
    private readonly vault: Vault,
    private readonly metadata: MetadataCache,
  ) {}
  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const loc = this.vault.getConfig('newFileLocation');
    if (loc === 'current' && sourcePath) {
      const f = this.vault.getAbstractFileByPath(sourcePath);
      if (f?.parent) return f.parent;
    }
    if (loc === 'folder') {
      const folder = this.vault.getFolderByPath(String(this.vault.getConfig('newFileFolderPath') ?? ''));
      if (folder) return folder;
    }
    return this.vault.getRoot();
  }
  async createNewMarkdownFile(folder: TFolder, filename: string, content = ''): Promise<TFile> {
    const base = folder.isRoot() ? '' : `${folder.path}/`;
    let name = `${base}${filename}.md`;
    for (let i = 1; this.vault.getAbstractFileByPath(name); i++) name = `${base}${filename} ${i}.md`;
    return this.vault.create(name, content);
  }
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath);
  }
  async trashFile(file: TAbstractFile): Promise<void> {
    await this.vault.trash(file);
  }
  generateMarkdownLink(file: TFile, sourcePath: string, subpath = '', alias = ''): string {
    const link = this.metadata.fileToLinktext(file, sourcePath);
    return `[[${link}${subpath}${alias ? `|${alias}` : ''}]]`;
  }
  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void): Promise<void> {
    await this.vault.process(file, (text) => {
      const info = getFrontMatterInfo(text);
      const fm = (info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown>) : null) ?? {};
      fn(fm);
      const yaml = Object.keys(fm).length ? stringifyYaml(fm) : '';
      const body = info.exists ? text.slice(info.contentStart) : text;
      return yaml ? `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\n${body}` : body;
    });
  }
  getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const folderSetting = String(this.vault.getConfig('attachmentFolderPath') ?? '');
    let dir = '';
    if (folderSetting.startsWith('./') && sourcePath) dir = [dirOf(sourcePath), folderSetting.slice(2)].filter(Boolean).join('/');
    else if (folderSetting && folderSetting !== '/') dir = folderSetting;
    return Promise.resolve(dir ? `${dir}/${filename}` : filename);
  }
}

export type { VFolder };
