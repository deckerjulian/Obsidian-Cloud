import * as Y from 'yjs';
import * as e2 from '@oc/shared/crypto';
import { YTEXT_FIELD, type TreeNodeDto } from '@oc/shared';
import { VaultStore } from '../../vault/VaultStore';
import type { WorkspaceHost, ViewMode } from '../host';

/**
 * An in-memory, end-to-end-encrypted "server" for tests: a real VaultStore
 * talks to a stubbed authFetch that stores encrypted Yjs updates and blobs,
 * exactly like the backend would (one content key for every node).
 */
export interface TestVault {
  store: VaultStore;
  host: WorkspaceHost & { opened: string[]; activePath: string | null; mode: ViewMode };
}

let seq = 0;
const uid = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** `protectedConfig: false` simulates a `.obsidian` folder the server does not
 *  protect (not flagged as the vault's config folder). */
export async function createTestVault(
  files: Record<string, string | Uint8Array>,
  { protectedConfig = true }: { protectedConfig?: boolean } = {},
): Promise<TestVault> {
  const key = await e2.generateContentKey();
  const vault: TreeNodeDto = node('folder', null, 'vault', 0, true);
  const nodes: TreeNodeDto[] = [vault];
  const names = new Map<string, string>([[vault.id, 'TestVault']]);
  const updates = new Map<string, string[]>(); // docId → enc updates (b64)
  const blobs = new Map<string, string>(); // docId → enc blob (b64)
  const folderIds = new Map<string, TreeNodeDto>([['', vault]]);

  function node(kind: 'folder' | 'file', parent: TreeNodeDto | null, _name: string, depth: number, isVault = false, isText = false): TreeNodeDto {
    const id = uid();
    return {
      id,
      parentId: parent?.id ?? null,
      kind,
      name: 'enc',
      path: parent ? `${parent.path}/${id}` : id,
      docId: uid(),
      isText,
      mime: null,
      depth,
      systemType: null,
      isVault,
      role: 'owner',
      capabilities: ['read', 'create', 'edit', 'delete', 'share'],
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    };
  }
  const ensureFolder = (path: string): TreeNodeDto => {
    const hit = folderIds.get(path);
    if (hit) return hit;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensureFolder(parentPath);
    const n = node('folder', parent, '', parent.depth + 1);
    if (path === '.obsidian' && protectedConfig) n.systemType = 'config';
    nodes.push(n);
    names.set(n.id, path.slice(path.lastIndexOf('/') + 1));
    folderIds.set(path, n);
    return n;
  };
  const encText = async (text: string): Promise<string> => {
    const doc = new Y.Doc();
    doc.getText(YTEXT_FIELD).insert(0, text);
    return e2.toBase64(await e2.encryptBytes(key, Y.encodeStateAsUpdate(doc), 'yupdate'));
  };
  const encBlob = async (bytes: Uint8Array): Promise<string> => e2.toBase64(await e2.encryptBytes(key, bytes, 'blob'));

  for (const [path, content] of Object.entries(files)) {
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensureFolder(parentPath);
    const isText = typeof content === 'string' && /\.md$/i.test(path) && !path.startsWith('.obsidian/');
    const n = node('file', parent, '', parent.depth + 1, false, isText);
    nodes.push(n);
    names.set(n.id, path.slice(path.lastIndexOf('/') + 1));
    if (isText) updates.set(n.docId!, [await encText(content as string)]);
    else blobs.set(n.docId!, await encBlob(typeof content === 'string' ? new TextEncoder().encode(content) : content));
  }

  let store!: VaultStore;
  const pendingKeys = new Map<string, CryptoKey>();
  const authFetch = async <T,>(path: string, opts?: { method?: string; body?: any }): Promise<T> => {
    const method = opts?.method ?? 'GET';
    let m: RegExpExecArray | null;
    if (path === '/documents/updates' && method === 'POST') {
      const docs = (opts!.body.docIds as string[])
        .filter((d) => updates.has(d))
        .map((d) => ({ docId: d, updates: updates.get(d)! }));
      return { docs } as T;
    }
    if ((m = /^\/documents\/([^/]+)\/updates$/.exec(path)) && method === 'POST') {
      updates.set(m[1], [...(updates.get(m[1]) ?? []), opts!.body.dataBase64]);
      return undefined as T;
    }
    if ((m = /^\/documents\/([^/]+)\/blob$/.exec(path))) {
      if (method === 'PUT') {
        blobs.set(m[1], opts!.body.contentBase64);
        return {} as T;
      }
      const c = blobs.get(m[1]);
      if (!c) throw new Error('404');
      return { docId: m[1], contentBase64: c, mime: null, sha256: '', size: 0 } as T;
    }
    if (path === '/nodes' && method === 'POST') {
      const b = opts!.body;
      const parent = nodes.find((n) => n.id === b.parentId)!;
      const n = node(b.kind, parent, '', parent.depth + 1, false, b.isText ?? false);
      nodes.push(n);
      names.set(n.id, await e2.decryptString(key, b.name, 'name'));
      return n as T;
    }
    if ((m = /^\/nodes\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      const victim = nodes.find((n) => n.id === m![1])!;
      for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].path.startsWith(victim.path)) nodes.splice(i, 1);
      return undefined as T;
    }
    throw new Error(`unhandled ${method} ${path}`);
  };
  store = new VaultStore(vault, 'TestVault', {
    authFetch,
    getContentKey: async () => key,
    prepareName: async (plaintext) => ({ encryptedName: await e2.encryptString(key, plaintext, 'name'), contentKey: key }),
    storeContentKey: async (docId, k) => void pendingKeys.set(docId, k),
    keyForGrantees: async () => 0,
    encryptNameFor: async (_d, plaintext) => e2.encryptString(key, plaintext, 'name'),
    reloadTree: async () => store.setTree(nodes, names),
  });
  store.setTree(nodes, names);

  const host = {
    store,
    opened: [] as string[],
    activePath: null as string | null,
    mode: 'preview' as ViewMode,
    openFile(path: string) {
      host.opened.push(path);
      host.activePath = path;
    },
    openLinkText(linktext: string, sourcePath: string) {
      const f = store.resolveLink(linktext, sourcePath);
      if (f) host.openFile(f.path);
    },
    getActiveFilePath: () => host.activePath,
    getActiveMode: () => host.mode,
    getActiveEditorView: () => null,
    rerenderActive: () => undefined,
    openView: () => undefined,
  };

  return { store, host };
}

/**
 * Minimal in-process Web Worker for blob: URL workers (Dataview's indexer).
 * The worker script assigns a global `onmessage` and calls `postMessage`.
 */
export function installFakeWorker(): void {
  const blobs = new Map<string, Blob>();
  let n = 0;
  const origCreate = URL.createObjectURL?.bind(URL);
  URL.createObjectURL = ((obj: Blob) => {
    const url = `blob:fake/${++n}`;
    blobs.set(url, obj);
    return url;
  }) as typeof URL.createObjectURL;
  void origCreate;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

  class FakeWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private handler: Promise<(ev: { data: unknown }) => unknown>;
    constructor(url: string) {
      const blob = blobs.get(url);
      if (!blob) throw new Error(`unknown worker url ${url}`);
      this.handler = blob.text().then((src) => {
        const post = (data: unknown): void => {
          setTimeout(() => this.onmessage?.({ data: structuredClone(data) }));
        };
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('postMessage', 'self', `var onmessage;\n${src}\n;return onmessage;`);
        const self = { postMessage: post };
        return fn(post, self) as (ev: { data: unknown }) => unknown;
      });
    }
    postMessage(data: unknown): void {
      const clone = structuredClone(data);
      void this.handler.then((h) => h({ data: clone }));
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    terminate(): void {}
  }
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
}

/** Poll until `fn` returns truthy (or time out). */
export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
