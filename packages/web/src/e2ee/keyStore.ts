/**
 * Persists the user's UNWRAPPED key pair in IndexedDB so a page reload doesn't
 * re-prompt for the passphrase. The private key is a NON-EXTRACTABLE CryptoKey
 * (see unwrapPrivateKey) — IndexedDB stores it opaquely, so scripts can't read
 * the raw bytes back out. It is cleared on lock / sign-out.
 */
const DB_NAME = 'oc-e2ee';
const STORE = 'keys';

export interface StoredKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function saveKeys(userId: string, keys: StoredKeys): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(keys, userId));
  } catch {
    /* private mode / no IndexedDB — fall back to in-memory only */
  }
}

export async function loadKeys(userId: string): Promise<StoredKeys | null> {
  try {
    const value = await tx<StoredKeys | undefined>('readonly', (s) => s.get(userId));
    return value && value.privateKey ? value : null;
  } catch {
    return null;
  }
}

export async function clearKeys(userId: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(userId));
  } catch {
    /* ignore */
  }
}

/**
 * Delete the per-document Yjs caches (y-indexeddb databases named `oc-<docId>`).
 * Those hold DECRYPTED document state, so locking or signing out must remove
 * them — otherwise "Encryption: locked" would be cosmetic for any note that was
 * opened, and anyone with device access could read it without the passphrase.
 */
export async function clearDocCaches(): Promise<void> {
  try {
    // indexedDB.databases() is unavailable in Firefox; nothing else can
    // enumerate the y-indexeddb DBs, so there we simply can't purge them.
    const list = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      list
        .map((d) => d.name)
        .filter(
          (n): n is string =>
            !!n && ((n.startsWith('oc-') && n !== DB_NAME) || n.startsWith('dataview/cache/oc-')),
        )
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    /* best-effort */
  }
}
