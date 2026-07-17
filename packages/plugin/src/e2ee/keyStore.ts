/**
 * Persists the unwrapped key pair in IndexedDB (available in Obsidian's Electron
 * renderer) so the E2EE passphrase isn't asked on every launch. The private key
 * is a NON-EXTRACTABLE CryptoKey — stored opaquely, never as raw bytes, and far
 * safer than writing the passphrase to data.json. Cleared on lock / sign-out.
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

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = op(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function saveKeys(userId: string, keys: StoredKeys): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(keys, userId));
  } catch {
    /* no IndexedDB — fall back to in-memory only */
  }
}

export async function loadKeys(userId: string): Promise<StoredKeys | null> {
  try {
    const value = await run<StoredKeys | undefined>('readonly', (s) => s.get(userId));
    return value && value.privateKey ? value : null;
  } catch {
    return null;
  }
}

export async function clearKeys(userId: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(userId));
  } catch {
    /* ignore */
  }
}
