import * as Y from 'yjs';
import * as e2 from '@oc/shared/crypto';
import {
  CONFIG_FOLDER_NAME,
  hasCapability,
  YTEXT_FIELD,
  MAX_BATCH_UPDATES,
  isTextFileName,
  type TreeNodeDto,
  type BlobContentDto,
  type BatchUpdatesResponse,
  type CreateNodeRequest,
} from '@oc/shared';
import { Events } from './events';
import { parseMetadata, type CachedMetadata } from './metadata';
import { LinkResolver, getLinkpath } from './linkResolver';
import { computeTextDiff } from './textDiff';

/** The vault-relative name of the config folder (fixed on the server). */
export const CONFIG_DIR = CONFIG_FOLDER_NAME;

export interface VFileStat {
  ctime: number;
  mtime: number;
  size: number;
}
export interface VFile {
  kind: 'file';
  path: string;
  name: string;
  basename: string;
  extension: string;
  parentPath: string;
  node: TreeNodeDto;
  stat: VFileStat;
}
export interface VFolder {
  kind: 'folder';
  path: string;
  name: string;
  parentPath: string;
  /** null for the vault root itself. */
  node: TreeNodeDto | null;
  children: Array<VFile | VFolder>;
}
export type VEntry = VFile | VFolder;

export interface VaultDeps {
  authFetch: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  getContentKey: (docId: string) => Promise<CryptoKey | null>;
  prepareName: (plaintext: string) => Promise<{ encryptedName: string; contentKey: CryptoKey }>;
  storeContentKey: (docId: string, contentKey: CryptoKey) => Promise<void>;
  keyForGrantees: (docId: string, contentKey: CryptoKey) => Promise<number>;
  encryptNameFor: (docId: string, plaintext: string) => Promise<string>;
  /** Fetch the tree again and feed it back through setTree(). */
  reloadTree: () => Promise<void>;
}

interface TextEntry {
  doc: Y.Doc;
  text: string;
  /** Content mtime (newest stored update), ms epoch. */
  mtime?: number;
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * The decrypted, in-memory view of ONE vault: paths, file contents, and an
 * Obsidian-style metadata cache. The server only ever sees ciphertext; this is
 * where names and notes become plaintext, on the device.
 *
 * Events (Obsidian names, so the plugin API shim can forward them):
 *  - 'create' | 'delete' (file) · 'rename' (file, oldPath) · 'modify' (file)
 *  - 'changed' (file, text, cache) · 'resolved' () · 'tree' ()
 */
export class VaultStore extends Events {
  readonly vaultId: string;
  readonly vaultName: string;
  private nodes: TreeNodeDto[] = [];
  private paths = new Map<string, string>(); // node id → vault path
  private filesByPath = new Map<string, VFile>();
  private foldersByPath = new Map<string, VFolder>();
  private configByPath = new Map<string, VFile>(); // path relative to CONFIG_DIR
  private configFolders = new Map<string, TreeNodeDto>();
  private configRoot: TreeNodeDto | null = null;
  private texts = new Map<string, TextEntry>(); // docId → content
  private meta = new Map<string, CachedMetadata>(); // path → metadata
  private stats = new Map<string, VFileStat>(); // node id → stable stat object
  private blobs = new Map<string, { at: string; bytes: Uint8Array }>(); // docId → bytes
  private urls = new Map<string, { at: string; url: string }>(); // docId → object URL
  private liveDocs = new Map<string, Y.Doc>(); // path → open editor doc
  private resolver: LinkResolver<VFile> | null = null;
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  /** True once every note's content has been loaded and indexed. */
  indexed = false;
  private loading: Promise<void> | null = null;

  constructor(
    readonly vaultNode: TreeNodeDto,
    vaultName: string,
    private readonly deps: VaultDeps,
  ) {
    super();
    this.vaultId = vaultNode.id;
    this.vaultName = vaultName;
  }

  // ── tree ───────────────────────────────────────────────────────────────────
  /**
   * Feed the (decrypted) tree. `names` maps node id → plaintext name. Emits
   * create/delete/rename for file changes since the previous call.
   */
  setTree(allNodes: TreeNodeDto[], names: Map<string, string>): void {
    const prefix = `${this.vaultNode.path}/`;
    const nodes = allNodes.filter((n) => n.path.startsWith(prefix));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const prevPaths = this.paths;
    const prevFiles = this.filesByPath;
    const paths = new Map<string, string>();
    const pathOf = (n: TreeNodeDto): string | null => {
      const cached = paths.get(n.id);
      if (cached !== undefined) return cached;
      const name = names.get(n.id);
      if (name === undefined || name === '') return null;
      let p: string;
      if (n.parentId === this.vaultId) p = name;
      else {
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        const pp = parent ? pathOf(parent) : null;
        if (pp === null) return null;
        p = `${pp}/${name}`;
      }
      paths.set(n.id, p);
      return p;
    };
    const files = new Map<string, VFile>();
    const folders = new Map<string, VFolder>();
    const config = new Map<string, VFile>();
    const configFolders = new Map<string, TreeNodeDto>();
    // The config folder is the one the server protects (systemType 'config';
    // only admins / plugin admins can change it). Before it is flagged, a
    // plain `.obsidian` folder is used for settings — but never for plugin code.
    const flagged = nodes.find((n) => n.parentId === this.vaultId && n.systemType === 'config');
    const configRoot: TreeNodeDto | null =
      flagged ??
      nodes.find((n) => n.parentId === this.vaultId && n.kind === 'folder' && names.get(n.id) === CONFIG_DIR) ??
      null;
    const root: VFolder = { kind: 'folder', path: '', name: this.vaultName, parentPath: '', node: null, children: [] };
    folders.set('', root);
    const cfgPrefix = `${CONFIG_DIR}/`;
    const cfgPathPrefix = configRoot ? `${configRoot.path}/` : null;
    for (const n of [...nodes].sort((a, b) => a.depth - b.depth)) {
      if (n === configRoot) continue;
      if (cfgPathPrefix && n.path.startsWith(cfgPathPrefix)) {
        const p = pathOf(n);
        const base = pathOf(configRoot!);
        if (p === null || base === null) continue;
        const rel = p.slice(base.length + 1);
        if (n.kind === 'file') config.set(rel, this.toFile(n, rel));
        else configFolders.set(rel, n);
        continue;
      }
      const p = pathOf(n);
      if (p === null) continue;
      // Any other `.obsidian` (a duplicate or impostor) stays hidden.
      if (p === CONFIG_DIR || p.startsWith(cfgPrefix)) continue;
      const name = p.slice(p.lastIndexOf('/') + 1);
      if (n.kind === 'folder') {
        folders.set(p, { kind: 'folder', path: p, name, parentPath: dirOf(p), node: n, children: [] });
      } else {
        files.set(p, this.toFile(n, p));
      }
    }
    for (const f of [...folders.values(), ...files.values()]) {
      if (f.path === '') continue;
      folders.get(f.parentPath)?.children.push(f);
    }
    this.nodes = nodes;
    this.paths = paths;
    this.filesByPath = files;
    this.foldersByPath = folders;
    this.configByPath = config;
    this.configFolders = configFolders;
    this.configRoot = configRoot;
    this.resolver = new LinkResolver(files.values());

    // Diff → Obsidian vault events (renames detected by node id).
    const newIdToPath = new Map<string, string>();
    for (const f of files.values()) newIdToPath.set(f.node.id, f.path);
    for (const [oldPath, f] of prevFiles) {
      const np = newIdToPath.get(f.node.id);
      if (np === undefined) {
        this.meta.delete(oldPath);
        this.trigger('delete', f);
      } else if (np !== oldPath) {
        const meta = this.meta.get(oldPath);
        this.meta.delete(oldPath);
        if (meta) this.meta.set(np, meta);
        this.trigger('rename', files.get(np), oldPath);
      }
    }
    for (const f of files.values()) {
      const old = prevPaths.get(f.node.id);
      if (old === undefined && prevFiles.size + prevPaths.size > 0) this.trigger('create', f);
    }
    this.trigger('tree');
    if (this.indexed) {
      // New notes need content; stale link maps need a recompute.
      void this.loadAllNotes().then(() => this.recomputeLinks());
    }
  }

  private toFile(n: TreeNodeDto, p: string): VFile {
    const name = p.slice(p.lastIndexOf('/') + 1);
    const extension = extOf(name);
    const t = Date.parse(n.updatedAt) || Date.now();
    const cached = n.docId ? this.texts.get(n.docId) : undefined;
    // One stat object per node for the store's lifetime: tree refreshes build
    // new VFile objects, but plugins (TFile.stat) and in-flight content loads
    // hold on to the stat — updating a replaced copy would be lost.
    let stat = this.stats.get(n.id);
    if (!stat) {
      stat = { ctime: t, mtime: t, size: 0 };
      this.stats.set(n.id, stat);
    }
    stat.ctime = Math.min(t, cached?.mtime ?? t, stat.ctime);
    stat.mtime = cached?.mtime ?? Math.max(stat.mtime, t);
    if (cached) stat.size = new TextEncoder().encode(cached.text).length;
    return {
      kind: 'file',
      path: p,
      name,
      basename: extension ? name.slice(0, -(extension.length + 1)) : name,
      extension,
      parentPath: dirOf(p),
      node: n,
      stat,
    };
  }

  get root(): VFolder {
    return this.foldersByPath.get('')!;
  }
  getFiles(): VFile[] {
    return [...this.filesByPath.values()];
  }
  getMarkdownFiles(): VFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }
  getFolders(): VFolder[] {
    return [...this.foldersByPath.values()];
  }
  getFile(path: string): VFile | null {
    return this.filesByPath.get(path) ?? null;
  }
  getFolder(path: string): VFolder | null {
    return this.foldersByPath.get(path) ?? null;
  }
  getEntry(path: string): VEntry | null {
    return this.getFile(path) ?? this.getFolder(path);
  }
  fileByNodeId(id: string): VFile | null {
    const p = this.paths.get(id);
    return p !== undefined ? this.getFile(p) : null;
  }

  // ── text content ───────────────────────────────────────────────────────────
  private async decodeUpdates(docId: string, updates: string[], updatedAt?: string | null): Promise<TextEntry | null> {
    const key = await this.deps.getContentKey(docId);
    if (!key) return null;
    const doc = new Y.Doc();
    for (const u of updates) {
      try {
        Y.applyUpdate(doc, await e2.decryptBytes(key, e2.fromBase64(u), 'yupdate'));
      } catch {
        /* undecryptable update: skip (same as the live provider does) */
      }
    }
    const mtime = updatedAt ? Date.parse(updatedAt) : undefined;
    return { doc, text: doc.getText(YTEXT_FIELD).toString(), mtime };
  }

  /** Fetch + decrypt the content of the given text docs (batched). */
  private async fetchTexts(docIds: string[]): Promise<Map<string, TextEntry>> {
    const out = new Map<string, TextEntry>();
    for (let i = 0; i < docIds.length; i += MAX_BATCH_UPDATES) {
      const res = await this.deps.authFetch<BatchUpdatesResponse>('/documents/updates', {
        method: 'POST',
        body: { docIds: docIds.slice(i, i + MAX_BATCH_UPDATES) },
      });
      await Promise.all(
        res.docs.map(async (d) => {
          const entry = await this.decodeUpdates(d.docId, d.updates, d.updatedAt);
          if (entry) out.set(d.docId, entry);
        }),
      );
    }
    return out;
  }

  private applyText(file: VFile, entry: TextEntry): void {
    const prev = file.node.docId ? this.texts.get(file.node.docId) : undefined;
    if (file.node.docId) {
      if (prev && prev.doc !== entry.doc) prev.doc.destroy();
      this.texts.set(file.node.docId, entry);
    }
    file.stat.size = new TextEncoder().encode(entry.text).length;
    // The content mtime (newest stored update) wins over the node's timestamp
    // — an imported note keeps its original date even though its node is new.
    if (entry.mtime) {
      file.stat.mtime = entry.mtime;
      file.stat.ctime = Math.min(file.stat.ctime, entry.mtime);
    }
    const changed = !prev || prev.text !== entry.text;
    if (file.extension === 'md' && (changed || !this.meta.has(file.path))) {
      const cache = parseMetadata(entry.text);
      this.meta.set(file.path, cache);
      if (prev && changed) this.trigger('modify', file);
      this.trigger('changed', file, entry.text, cache);
    } else if (prev && changed) this.trigger('modify', file);
  }

  /** Load (once) and index every note in the vault. */
  loadAllNotes(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const textFiles = this.getFiles().filter(
        (f) => f.node.isText && f.node.docId && !this.texts.has(f.node.docId),
      );
      const loaded = await this.fetchTexts(textFiles.map((f) => f.node.docId!));
      for (const f of textFiles) {
        const entry = loaded.get(f.node.docId!);
        if (entry) this.applyText(f, entry);
      }
      if (!this.indexed) {
        this.indexed = true;
        this.recomputeLinks();
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Re-fetch every note (picks up edits from other devices). */
  async refreshAllNotes(): Promise<void> {
    const textFiles = this.getFiles().filter((f) => f.node.isText && f.node.docId && !this.liveDocs.has(f.path));
    const loaded = await this.fetchTexts(textFiles.map((f) => f.node.docId!));
    for (const f of textFiles) {
      const entry = loaded.get(f.node.docId!);
      if (entry) this.applyText(f, entry);
    }
    this.recomputeLinks();
  }

  async read(path: string): Promise<string> {
    const f = this.getFile(path);
    if (!f) throw new Error(`File not found: ${path}`);
    if (!f.node.isText) return new TextDecoder().decode(await this.readBinary(path));
    const live = this.liveDocs.get(path);
    if (live) return live.getText(YTEXT_FIELD).toString();
    const cached = this.texts.get(f.node.docId!);
    if (cached) return cached.text;
    const loaded = await this.fetchTexts([f.node.docId!]);
    const entry = loaded.get(f.node.docId!);
    if (!entry) throw new Error(`No encryption key for ${path}`);
    this.applyText(f, entry);
    return entry.text;
  }

  /** Synchronous cached text (null when not loaded yet). */
  cachedText(path: string): string | null {
    const f = this.getFile(path);
    if (!f?.node.docId) return null;
    const live = this.liveDocs.get(path);
    if (live) return live.getText(YTEXT_FIELD).toString();
    return this.texts.get(f.node.docId)?.text ?? null;
  }

  /** An editor opened this note: writes go through its live Y.Doc, and its
   *  edits update the index immediately. Returns a detach function. */
  attachLiveDoc(path: string, doc: Y.Doc): () => void {
    this.liveDocs.set(path, doc);
    const ytext = doc.getText(YTEXT_FIELD);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const f = this.getFile(path);
        if (!f?.node.docId) return;
        const text = ytext.toString();
        const prev = this.texts.get(f.node.docId);
        if (prev?.text === text) return;
        // Keep the cached doc (its Yjs state is stale, but writes go via the
        // live doc while attached and re-fetch afterwards).
        if (prev) {
          prev.text = text;
          prev.mtime = Date.now();
        } else this.texts.set(f.node.docId, { doc: new Y.Doc(), text, mtime: Date.now() });
        f.stat.size = text.length;
        f.stat.mtime = Date.now();
        if (f.extension === 'md') {
          const cache = parseMetadata(text);
          this.meta.set(path, cache);
          this.trigger('modify', f);
          this.trigger('changed', f, text, cache);
          this.recomputeLinks();
        }
      }, 400);
    };
    ytext.observe(onChange);
    return () => {
      ytext.unobserve(onChange);
      if (timer) clearTimeout(timer);
      if (this.liveDocs.get(path) === doc) this.liveDocs.delete(path);
      // The cached Yjs state is now behind the server — drop it so the next
      // write re-fetches a fresh base.
      const f = this.getFile(path);
      if (f?.node.docId) {
        const entry = this.texts.get(f.node.docId);
        if (entry) {
          entry.doc.destroy();
          entry.doc = new Y.Doc();
          (entry as TextEntry & { stale?: boolean }).stale = true;
        }
      }
    };
  }

  /** Replace a note's content (minimal diff → one encrypted Yjs update). */
  async write(path: string, text: string): Promise<void> {
    const f = this.getFile(path);
    if (!f?.node.docId) throw new Error(`File not found: ${path}`);
    if (!f.node.isText) {
      await this.writeBinary(path, new TextEncoder().encode(text));
      return;
    }
    const live = this.liveDocs.get(path);
    if (live) {
      const ytext = live.getText(YTEXT_FIELD);
      const { pos, delCount, insStr } = computeTextDiff(ytext.toString(), text);
      live.transact(() => {
        if (delCount > 0) ytext.delete(pos, delCount);
        if (insStr) ytext.insert(pos, insStr);
      });
      return; // the editor's provider persists + broadcasts it
    }
    // Always diff against the server's CURRENT state: a stale base would make
    // the CRDT merge duplicate text that changed elsewhere meanwhile.
    const fresh = (await this.fetchTexts([f.node.docId])).get(f.node.docId);
    if (!fresh) throw new Error(`No encryption key for ${path}`);
    const key = await this.deps.getContentKey(f.node.docId);
    if (!key) throw new Error(`No encryption key for ${path}`);
    const ytext = fresh.doc.getText(YTEXT_FIELD);
    const { pos, delCount, insStr } = computeTextDiff(ytext.toString(), text);
    if (delCount === 0 && !insStr) {
      this.applyText(f, fresh);
      return;
    }
    let update: Uint8Array | null = null;
    const onUpdate = (u: Uint8Array): void => {
      update = update ? Y.mergeUpdates([update, u]) : u;
    };
    fresh.doc.on('update', onUpdate);
    fresh.doc.transact(() => {
      if (delCount > 0) ytext.delete(pos, delCount);
      if (insStr) ytext.insert(pos, insStr);
    });
    fresh.doc.off('update', onUpdate);
    if (update) {
      const enc = await e2.encryptBytes(key, update, 'yupdate');
      await this.deps.authFetch(`/documents/${f.node.docId}/updates`, {
        method: 'POST',
        body: { dataBase64: e2.toBase64(enc) },
      });
    }
    fresh.text = ytext.toString();
    fresh.mtime = Date.now();
    this.applyText(f, fresh);
    this.recomputeLinks();
  }

  // ── binary content ─────────────────────────────────────────────────────────
  private async readBlob(node: TreeNodeDto): Promise<Uint8Array> {
    const docId = node.docId!;
    const hit = this.blobs.get(docId);
    if (hit && hit.at === node.updatedAt) return hit.bytes;
    const key = await this.deps.getContentKey(docId);
    if (!key) throw new Error('No encryption key for this file');
    const b = await this.deps.authFetch<BlobContentDto>(`/documents/${docId}/blob`);
    const bytes = await e2.decryptBytes(key, e2.fromBase64(b.contentBase64), 'blob');
    // Keep big binaries (PDFs, books) out of the cache; images are re-used.
    if (bytes.byteLength < 8 * 1024 * 1024) this.blobs.set(docId, { at: node.updatedAt, bytes });
    return bytes;
  }

  async readBinary(path: string): Promise<Uint8Array> {
    const f = this.getFile(path);
    if (!f?.node.docId) throw new Error(`File not found: ${path}`);
    if (f.node.isText) return new TextEncoder().encode(await this.read(path));
    return this.readBlob(f.node);
  }

  /** A blob: URL with the decrypted bytes (cached per file version). */
  async resourceUrl(path: string): Promise<string> {
    const f = this.getFile(path);
    if (!f?.node.docId) throw new Error(`File not found: ${path}`);
    const hit = this.urls.get(f.node.docId);
    if (hit && hit.at === f.node.updatedAt) return hit.url;
    const bytes = await this.readBinary(path);
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeFor(f) }));
    if (hit) URL.revokeObjectURL(hit.url);
    this.urls.set(f.node.docId, { at: f.node.updatedAt, url });
    return url;
  }

  async writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    const f = this.getFile(path);
    if (!f?.node.docId) throw new Error(`File not found: ${path}`);
    await this.uploadBlob(f.node.docId, bytes, mimeFor(f));
    this.blobs.delete(f.node.docId);
    await this.deps.reloadTree();
  }

  private async uploadBlob(docId: string, bytes: Uint8Array, mime: string): Promise<void> {
    const key = await this.deps.getContentKey(docId);
    if (!key) throw new Error('No encryption key for this file');
    const enc = await e2.encryptBytes(key, bytes, 'blob');
    await this.deps.authFetch(`/documents/${docId}/blob`, {
      method: 'PUT',
      body: { contentBase64: e2.toBase64(enc), mime },
    });
  }

  // ── structure changes ──────────────────────────────────────────────────────
  private parentIdFor(parentPath: string, inConfig = false): string {
    if (inConfig) {
      if (parentPath === '') {
        if (!this.configRoot) throw new Error('No config folder');
        return this.configRoot.id;
      }
      const n = this.configFolders.get(parentPath);
      if (!n) throw new Error(`Folder not found: ${CONFIG_DIR}/${parentPath}`);
      return n.id;
    }
    if (parentPath === '') return this.vaultId;
    const folder = this.foldersByPath.get(parentPath);
    if (!folder?.node) throw new Error(`Folder not found: ${parentPath}`);
    return folder.node.id;
  }

  private async createNode(req: CreateNodeRequest, name: string): Promise<{ node: TreeNodeDto; key: CryptoKey }> {
    const { encryptedName, contentKey } = await this.deps.prepareName(name);
    const node = await this.deps.authFetch<TreeNodeDto>('/nodes', {
      method: 'POST',
      body: { ...req, name: encryptedName },
    });
    if (!node.docId) throw new Error('Server returned a node without docId');
    await this.deps.storeContentKey(node.docId, contentKey);
    await this.deps.keyForGrantees(node.docId, contentKey).catch(() => 0);
    return { node, key: contentKey };
  }

  async createFolder(path: string): Promise<void> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    await this.createNode({ parentId: this.parentIdFor(dirOf(path)), kind: 'folder', name }, name);
    await this.deps.reloadTree();
  }

  /** Create a note (or any file) with initial content. */
  async create(path: string, content: string | Uint8Array = ''): Promise<VFile> {
    if (this.getFile(path)) throw new Error('File already exists.');
    const name = path.slice(path.lastIndexOf('/') + 1);
    const isText = typeof content === 'string' && isTextFileName(name);
    const parentPath = dirOf(path);
    if (parentPath && !this.getFolder(parentPath)) await this.createFolder(parentPath);
    const { node, key } = await this.createNode(
      { parentId: this.parentIdFor(parentPath), kind: 'file', name, isText },
      name,
    );
    if (isText) {
      if (content) {
        const doc = new Y.Doc();
        doc.getText(YTEXT_FIELD).insert(0, content as string);
        const enc = await e2.encryptBytes(key, Y.encodeStateAsUpdate(doc), 'yupdate');
        await this.deps.authFetch(`/documents/${node.docId}/updates`, {
          method: 'POST',
          body: { dataBase64: e2.toBase64(enc) },
        });
        this.texts.set(node.docId!, { doc, text: content as string });
      } else this.texts.set(node.docId!, { doc: new Y.Doc(), text: '' });
    } else {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      await this.uploadBlob(node.docId!, bytes, mimeByExt(extOf(name)));
    }
    await this.deps.reloadTree();
    const f = this.getFile(path);
    if (!f) throw new Error('Created file did not appear');
    const entry = this.texts.get(node.docId!);
    if (entry) this.applyText(f, entry);
    return f;
  }

  async delete(path: string): Promise<void> {
    const e = this.getEntry(path);
    if (!e?.node) throw new Error(`Not found: ${path}`);
    await this.deps.authFetch(`/nodes/${e.node.id}`, { method: 'DELETE' });
    await this.deps.reloadTree();
  }

  async rename(path: string, newPath: string): Promise<void> {
    const e = this.getEntry(path);
    if (!e?.node?.docId) throw new Error(`Not found: ${path}`);
    const newName = newPath.slice(newPath.lastIndexOf('/') + 1);
    const body: { name?: string; parentId?: string } = {};
    if (newName !== e.name) body.name = await this.deps.encryptNameFor(e.node.docId, newName);
    if (dirOf(newPath) !== dirOf(path)) {
      if (dirOf(newPath) && !this.getFolder(dirOf(newPath))) await this.createFolder(dirOf(newPath));
      body.parentId = this.parentIdFor(dirOf(newPath));
    }
    if (!body.name && !body.parentId) return;
    await this.deps.authFetch(`/nodes/${e.node.id}`, { method: 'PATCH', body });
    await this.deps.reloadTree();
  }

  // ── vault config (.obsidian) ───────────────────────────────────────────────
  /** Whether the config folder is the server-protected one. Plugin code is
   *  only ever loaded from a protected folder. */
  get configTrusted(): boolean {
    return this.configRoot?.systemType === 'config';
  }
  /** Whether this user may change the vault's config in the cloud (admins /
   *  plugin admins, with write access to the vault). */
  get configWritable(): boolean {
    const target = this.configRoot ?? this.vaultNode;
    return hasCapability(target.capabilities, 'edit') || hasCapability(target.capabilities, 'create');
  }
  /**
   * Flag a `.obsidian` folder created before protection existed as the vault's
   * config folder (admins / plugin admins). Returns true when it changed.
   */
  async protectConfigFolder(canManageConfig: boolean): Promise<boolean> {
    const root = this.configRoot;
    if (!canManageConfig || !root || root.systemType === 'config' || !hasCapability(root.capabilities, 'edit')) return false;
    await this.deps.authFetch(`/nodes/${root.id}`, { method: 'PATCH', body: { systemType: 'config' } });
    await this.deps.reloadTree();
    return true;
  }
  configFiles(): string[] {
    return [...this.configByPath.keys()];
  }
  hasConfig(rel: string): boolean {
    return this.configByPath.has(rel);
  }
  async readConfig(rel: string): Promise<string | null> {
    const f = this.configByPath.get(rel);
    if (!f) return null;
    return new TextDecoder().decode(await this.readBlob(f.node));
  }
  async readConfigJson<T>(rel: string): Promise<T | null> {
    const text = await this.readConfig(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
  /** Write a config file (e.g. a plugin's data.json), creating folders. */
  async writeConfig(rel: string, text: string): Promise<void> {
    // Only admins / plugin admins may change the vault config in the cloud;
    // for everyone else plugin settings stay as they are on the server.
    if (!this.configWritable || (this.configRoot && !this.configTrusted)) {
      console.info(`[vault] ${CONFIG_DIR}/${rel} not saved: the vault config is managed by plugin admins.`);
      return;
    }
    const bytes = new TextEncoder().encode(text);
    const existing = this.configByPath.get(rel);
    if (existing?.node.docId) {
      await this.uploadBlob(existing.node.docId, bytes, mimeByExt(extOf(rel)));
      this.blobs.delete(existing.node.docId);
      return;
    }
    if (!this.configRoot) {
      await this.createNode({ parentId: this.vaultId, kind: 'folder', name: CONFIG_DIR, systemType: 'config' }, CONFIG_DIR);
      await this.deps.reloadTree();
    }
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k++) {
      const sub = parts.slice(0, k).join('/');
      if (!this.configFolders.has(sub)) {
        await this.createNode(
          { parentId: this.parentIdFor(parts.slice(0, k - 1).join('/'), true), kind: 'folder', name: parts[k - 1] },
          parts[k - 1],
        );
        await this.deps.reloadTree();
      }
    }
    const name = parts[parts.length - 1];
    const { node } = await this.createNode(
      { parentId: this.parentIdFor(parts.slice(0, -1).join('/'), true), kind: 'file', name, isText: false },
      name,
    );
    await this.uploadBlob(node.docId!, bytes, mimeByExt(extOf(rel)));
    await this.deps.reloadTree();
  }
  /** Raw bytes of a config file (themes may reference fonts etc.). */
  async readConfigBinary(rel: string): Promise<Uint8Array | null> {
    const f = this.configByPath.get(rel);
    return f ? this.readBlob(f.node) : null;
  }

  // ── metadata ───────────────────────────────────────────────────────────────
  getFileCache(path: string): CachedMetadata | null {
    return this.meta.get(path) ?? null;
  }

  resolveLink(linktext: string, sourcePath: string): VFile | null {
    return this.resolver?.resolve(getLinkpath(linktext), sourcePath) ?? null;
  }

  private recomputeLinks(): void {
    const resolved: Record<string, Record<string, number>> = {};
    const unresolved: Record<string, Record<string, number>> = {};
    for (const [path, cache] of this.meta) {
      const r: Record<string, number> = {};
      const u: Record<string, number> = {};
      const all = [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])];
      for (const l of all) {
        const lp = getLinkpath(l.link);
        if (!lp) continue;
        const target = this.resolveLink(lp, path);
        if (target) r[target.path] = (r[target.path] ?? 0) + 1;
        else u[lp] = (u[lp] ?? 0) + 1;
      }
      resolved[path] = r;
      unresolved[path] = u;
    }
    this.resolvedLinks = resolved;
    this.unresolvedLinks = unresolved;
    this.trigger('resolved');
  }

  /** Notes linking to `path`, with the link count. */
  backlinks(path: string): Array<{ source: string; count: number }> {
    const out: Array<{ source: string; count: number }> = [];
    for (const [source, targets] of Object.entries(this.resolvedLinks)) {
      if (source !== path && targets[path]) out.push({ source, count: targets[path] });
    }
    return out.sort((a, b) => a.source.localeCompare(b.source));
  }

  destroy(): void {
    for (const { url } of this.urls.values()) URL.revokeObjectURL(url);
    for (const t of this.texts.values()) t.doc.destroy();
    this.urls.clear();
    this.texts.clear();
  }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', css: 'text/css',
  js: 'text/javascript', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
  mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'video/webm',
  ogg: 'audio/ogg', csv: 'text/csv', epub: 'application/epub+zip', base: 'text/yaml',
  canvas: 'application/json',
};
export function mimeByExt(ext: string): string {
  return MIME[ext] ?? 'application/octet-stream';
}
function mimeFor(f: VFile): string {
  return f.node.mime && f.node.mime !== 'application/octet-stream' ? f.node.mime : mimeByExt(f.extension);
}
