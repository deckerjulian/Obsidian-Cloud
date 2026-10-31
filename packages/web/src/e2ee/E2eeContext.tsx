import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as e2 from '@oc/shared/crypto';
import { ApiError } from '../api/http';
import { e2eeApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { saveKeys, loadKeys, clearKeys, clearDocCaches } from './keyStore';

export type E2eeStatus = 'loading' | 'not-setup' | 'locked' | 'unlocked';

/** Trust-on-first-use state of a share target's public key on this device. */
export type KeyTrustState = 'new' | 'trusted' | 'changed';

const PIN_PREFIX = 'oc.pubkey.';
const readPin = (userId: string): string | null => {
  try {
    return localStorage.getItem(PIN_PREFIX + userId);
  } catch {
    return null;
  }
};
const writePin = (userId: string, fingerprint: string): void => {
  try {
    localStorage.setItem(PIN_PREFIX + userId, fingerprint);
  } catch {
    /* storage unavailable — pinning is best-effort */
  }
};

interface E2eeContextValue {
  status: E2eeStatus;
  /** First-time setup: generate a key pair, protect it with the passphrase. */
  setup: (passphrase: string) => Promise<void>;
  /** Unlock the stored private key with the passphrase. */
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  /** Fetch + unwrap the caller's content key for a document (null if none exists). */
  getContentKey: (docId: string) => Promise<CryptoKey | null>;
  /** Create a fresh content key for a new document and wrap it for the creator. */
  provisionDocumentKey: (docId: string) => Promise<CryptoKey>;
  /** Re-wrap the content keys of the given documents for another user (sharing). */
  shareDocuments: (docIds: string[], userId: string) => Promise<{ shared: number; skipped: number }>;
  /** The target's current public-key fingerprint and how it compares to the
   *  one this device trusted before (TOFU). */
  publicKeyInfo: (userId: string) => Promise<{ fingerprint: string; state: KeyTrustState } | null>;
  /** Trust (pin) a user's current public-key fingerprint on this device. */
  trustPublicKey: (userId: string, fingerprint: string) => void;
  /** Revoke another user's content keys for the given documents. */
  revokeDocuments: (docIds: string[], userId: string) => Promise<void>;
  /** Generate a content key + encrypt a node name with it (for creating a node). */
  prepareName: (plaintext: string) => Promise<{ encryptedName: string; contentKey: CryptoKey }>;
  /** Wrap + store a content key for a (just-created) document, for the caller. */
  storeContentKey: (docId: string, contentKey: CryptoKey) => Promise<void>;
  /** Fan a new node's content key out to everyone who already has access to
   *  the folder it was created in. Returns how many grantees were keyed. */
  keyForGrantees: (docId: string, contentKey: CryptoKey) => Promise<number>;
  /** Encrypt a new name with an existing document's content key (rename). */
  encryptNameFor: (docId: string, plaintext: string) => Promise<string>;
  /** Decrypt a node name; falls back to the raw value (legacy plaintext / no key). */
  decryptName: (docId: string | null, ciphertext: string) => Promise<string>;
  isUnlocked: boolean;
}

const E2eeContext = createContext<E2eeContextValue | null>(null);

export function E2eeProvider({ children }: { children: ReactNode }) {
  const { user, authFetch } = useAuth();
  const api = useMemo(() => e2eeApi(authFetch), [authFetch]);
  const [status, setStatus] = useState<E2eeStatus>('loading');
  const privateKey = useRef<CryptoKey | null>(null);
  const publicKey = useRef<CryptoKey | null>(null);
  const keyCache = useRef<Map<string, CryptoKey>>(new Map());
  const bulkKeys = useRef<Promise<Map<string, string>> | null>(null);
  const owner = useRef<string | null>(null); // userId whose keys are loaded

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      // Sign-out: forget the keys AND the decrypted Yjs doc caches on device.
      if (owner.current) void clearKeys(owner.current);
      void clearDocCaches();
      owner.current = null;
      privateKey.current = null;
      publicKey.current = null;
      keyCache.current.clear();
      setStatus('loading');
      return;
    }
    // Already unlocked for this user? A token refresh re-runs this effect (the
    // user object changes identity); without this guard a device where
    // IndexedDB is unavailable (private mode) would flip back to 'locked' and
    // re-prompt, even though the in-memory key is still valid.
    if (owner.current === userId && privateKey.current) {
      setStatus('unlocked');
      return;
    }
    let active = true;
    void (async () => {
      // Reuse a previously-unlocked key from this device (no re-prompt on reload).
      const stored = await loadKeys(userId);
      if (!active) return;
      if (stored) {
        privateKey.current = stored.privateKey;
        publicKey.current = stored.publicKey;
        owner.current = userId;
        setStatus('unlocked');
        return;
      }
      try {
        await api.myKeys();
        if (active) setStatus('locked');
      } catch (err) {
        if (active) setStatus(err instanceof ApiError && err.status === 404 ? 'not-setup' : 'locked');
      }
    })();
    return () => {
      active = false;
    };
  }, [userId, api]);

  // Admins may read all files: once unlocked, ensure every admin holds a
  // wrapped content key for the documents THIS user can decrypt. Runs once per
  // (user, admin-set) — the signature in localStorage gates re-runs.
  const adminBackfillFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'unlocked' || !userId || !privateKey.current) return;
    if (adminBackfillFor.current === userId) return;
    adminBackfillFor.current = userId;
    let active = true;
    void (async () => {
      try {
        const admins = await api.adminKeys();
        const signature = admins
          .map((a) => `${a.userId}:${a.publicKey.slice(-24)}`)
          .sort()
          .join('|');
        const sigKey = `oc.adminKeys.${userId}`;
        if (admins.length === 0 || localStorage.getItem(sigKey) === signature) return;
        const priv = privateKey.current;
        if (!priv) return;
        const adminKeys = await Promise.all(
          admins.map(async (a) => ({ userId: a.userId, key: await e2.importPublicKey(a.publicKey) })),
        );
        // Only the gaps (older servers: every doc).
        const gaps = await api.adminKeyGaps().then((g) => new Set(g.docIds)).catch(() => null);
        const myDocs = (await api.myDocumentKeys()).filter((k) => !gaps || gaps.has(k.docId));
        for (const { docId, wrappedKey } of myDocs) {
          if (!active) return;
          let contentKey: CryptoKey;
          try {
            contentKey = await e2.unwrapContentKey(wrappedKey, priv);
          } catch {
            continue; // not decryptable by us
          }
          const entries = await Promise.all(
            adminKeys.map(async (a) => ({
              userId: a.userId,
              wrappedKey: await e2.wrapContentKeyForUser(contentKey, a.key),
            })),
          );
          await api.setDocumentKeys(docId, { entries }).catch(() => undefined);
        }
        if (active) localStorage.setItem(sigKey, signature);
      } catch {
        adminBackfillFor.current = null; // allow a retry on the next unlock
      }
    })();
    return () => {
      active = false;
    };
  }, [status, userId, api]);

  const setup = useCallback(
    async (passphrase: string) => {
      // createUserKeys only ever hands out a NON-extractable private key —
      // the extractable original needed for wrapping never leaves the helper.
      const keys = await e2.createUserKeys(passphrase);
      await api.registerKeys({
        publicKey: keys.publicKeyB64,
        encryptedPrivateKey: keys.encryptedPrivateKey,
        kdfSalt: keys.kdfSalt,
      });
      privateKey.current = keys.privateKey;
      publicKey.current = keys.publicKey;
      if (user) {
        owner.current = user.id;
        await saveKeys(user.id, { privateKey: keys.privateKey, publicKey: keys.publicKey });
      }
      setStatus('unlocked');
    },
    [api, user],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      const keys = await api.myKeys();
      const wrappingKey = await e2.deriveWrappingKey(passphrase, keys.kdfSalt);
      // Throws (AES-GCM auth failure) on a wrong passphrase.
      const priv = await e2.unwrapPrivateKey(keys.encryptedPrivateKey, wrappingKey);
      const pub = await e2.importPublicKey(keys.publicKey);
      privateKey.current = priv;
      publicKey.current = pub;
      if (user) {
        owner.current = user.id;
        await saveKeys(user.id, { privateKey: priv, publicKey: pub });
      }
      setStatus('unlocked');
    },
    [api, user],
  );

  const lock = useCallback(() => {
    if (owner.current) void clearKeys(owner.current);
    // Purge decrypted document caches so "locked" is not merely cosmetic.
    void clearDocCaches();
    owner.current = null;
    privateKey.current = null;
    publicKey.current = null;
    keyCache.current.clear();
    setStatus('locked');
  }, []);

  const getContentKey = useCallback(
    async (docId: string): Promise<CryptoKey | null> => {
      if (!privateKey.current) throw new Error('Encryption is locked');
      const cached = keyCache.current.get(docId);
      if (cached) return cached;
      try {
        // Opening a vault decrypts hundreds of names at once: fetch every
        // wrapped key in ONE request (shared across concurrent callers)
        // instead of one request per node, which trips the rate limit.
        if (!bulkKeys.current) {
          bulkKeys.current = api
            .myDocumentKeys()
            .then((list) => new Map(list.map((k) => [k.docId, k.wrappedKey])))
            .catch(() => new Map<string, string>());
          // Keys shared later must be re-fetched eventually.
          setTimeout(() => (bulkKeys.current = null), 30_000);
        }
        const bulk = await bulkKeys.current;
        let wrappedKey = bulk.get(docId);
        if (!wrappedKey) {
          // Not in the bulk list: either no key (most nodes an admin can see)
          // or shared after the list was fetched — only then ask individually.
          if (bulk.size > 0) return null;
          wrappedKey = (await api.documentKey(docId)).wrappedKey;
        }
        const key = await e2.unwrapContentKey(wrappedKey, privateKey.current);
        keyCache.current.set(docId, key);
        return key;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    [api],
  );

  const provisionDocumentKey = useCallback(
    async (docId: string): Promise<CryptoKey> => {
      if (!publicKey.current || !user) throw new Error('Encryption is locked');
      const contentKey = await e2.generateContentKey();
      const wrappedKey = await e2.wrapContentKeyForUser(contentKey, publicKey.current);
      await api.setDocumentKeys(docId, { entries: [{ userId: user.id, wrappedKey }] });
      keyCache.current.set(docId, contentKey);
      return contentKey;
    },
    [api, user],
  );

  const publicKeyInfo = useCallback(
    async (userId: string): Promise<{ fingerprint: string; state: KeyTrustState } | null> => {
      const target = (await api.publicKeys()).find((p) => p.userId === userId);
      if (!target?.publicKey) return null;
      const fingerprint = await e2.fingerprintPublicKey(target.publicKey);
      const pinned = readPin(userId);
      const state: KeyTrustState = !pinned ? 'new' : pinned === fingerprint ? 'trusted' : 'changed';
      return { fingerprint, state };
    },
    [api],
  );

  const trustPublicKey = useCallback((userId: string, fingerprint: string) => {
    writePin(userId, fingerprint);
  }, []);

  const shareDocuments = useCallback(
    async (docIds: string[], userId: string) => {
      if (!privateKey.current) throw new Error('Encryption is locked');
      const target = (await api.publicKeys()).find((p) => p.userId === userId);
      if (!target?.publicKey) {
        throw new Error('That user has not set up encryption yet, so notes cannot be shared with them.');
      }
      // Trust-on-first-use: a public key that CHANGED since we last shared can
      // mean the server swapped it to intercept the content key. Refuse until
      // the new fingerprint is explicitly trusted (verified out of band).
      const fingerprint = await e2.fingerprintPublicKey(target.publicKey);
      const pinned = readPin(userId);
      if (pinned && pinned !== fingerprint) {
        throw new Error(
          "This user's encryption key changed since you last shared with them. " +
            'Verify the new fingerprint with them, then trust it, before sharing.',
        );
      }
      const targetKey = await e2.importPublicKey(target.publicKey);
      let shared = 0;
      let skipped = 0;
      for (const docId of docIds) {
        const contentKey = await getContentKey(docId); // unwrap mine (cached)
        if (!contentKey) {
          skipped++; // I can't decrypt it myself → can't share it
          continue;
        }
        const wrappedKey = await e2.wrapContentKeyForUser(contentKey, targetKey);
        await api.setDocumentKeys(docId, { entries: [{ userId, wrappedKey }] });
        shared++;
      }
      // First successful share establishes the trusted key (TOFU).
      if (!pinned) writePin(userId, fingerprint);
      return { shared, skipped };
    },
    [api, getContentKey],
  );

  const revokeDocuments = useCallback(
    async (docIds: string[], userId: string) => {
      for (const docId of docIds) {
        await api.removeDocumentKey(docId, userId).catch(() => undefined);
      }
    },
    [api],
  );

  const prepareName = useCallback(async (plaintext: string) => {
    const contentKey = await e2.generateContentKey();
    const encryptedName = await e2.encryptString(contentKey, plaintext, 'name');
    return { encryptedName, contentKey };
  }, []);

  const storeContentKey = useCallback(
    async (docId: string, contentKey: CryptoKey) => {
      if (!publicKey.current || !user) throw new Error('Encryption is locked');
      const wrappedKey = await e2.wrapContentKeyForUser(contentKey, publicKey.current);
      await api.setDocumentKeys(docId, { entries: [{ userId: user.id, wrappedKey }] });
      keyCache.current.set(docId, contentKey);
    },
    [api, user],
  );

  const keyForGrantees = useCallback(
    async (docId: string, contentKey: CryptoKey): Promise<number> => {
      const grantees = await api.grantees(docId).catch(() => []);
      if (grantees.length === 0) return 0;
      const entries: Array<{ userId: string; wrappedKey: string }> = [];
      for (const g of grantees) {
        // Respect the same TOFU pins as explicit sharing: never wrap the key
        // for a public key that changed under us (possible server key swap).
        // Unpinned keys are trusted-on-first-use here and pinned.
        const fingerprint = await e2.fingerprintPublicKey(g.publicKey);
        const pinned = readPin(g.userId);
        if (pinned && pinned !== fingerprint) continue; // skip — owner can re-share to fix
        const targetKey = await e2.importPublicKey(g.publicKey);
        entries.push({ userId: g.userId, wrappedKey: await e2.wrapContentKeyForUser(contentKey, targetKey) });
        if (!pinned) writePin(g.userId, fingerprint);
      }
      if (entries.length > 0) await api.setDocumentKeys(docId, { entries });
      return entries.length;
    },
    [api],
  );

  const encryptNameFor = useCallback(
    async (docId: string, plaintext: string) => {
      const key = await getContentKey(docId);
      if (!key) throw new Error('No encryption key for this item.');
      return e2.encryptString(key, plaintext, 'name');
    },
    [getContentKey],
  );

  const decryptName = useCallback(
    async (docId: string | null, ciphertext: string): Promise<string> => {
      if (!docId || ciphertext === '') return ciphertext;
      try {
        const key = await getContentKey(docId);
        if (!key) return ciphertext; // legacy plaintext or no key for us
        return await e2.decryptString(key, ciphertext, 'name');
      } catch {
        return ciphertext; // not our ciphertext / legacy plaintext name
      }
    },
    [getContentKey],
  );

  const value = useMemo<E2eeContextValue>(
    () => ({
      status,
      setup,
      unlock,
      lock,
      getContentKey,
      provisionDocumentKey,
      shareDocuments,
      publicKeyInfo,
      trustPublicKey,
      revokeDocuments,
      prepareName,
      storeContentKey,
      keyForGrantees,
      encryptNameFor,
      decryptName,
      isUnlocked: status === 'unlocked',
    }),
    [
      status,
      setup,
      unlock,
      lock,
      getContentKey,
      provisionDocumentKey,
      shareDocuments,
      publicKeyInfo,
      trustPublicKey,
      revokeDocuments,
      prepareName,
      storeContentKey,
      keyForGrantees,
      encryptNameFor,
      decryptName,
    ],
  );

  return <E2eeContext.Provider value={value}>{children}</E2eeContext.Provider>;
}

export function useE2ee(): E2eeContextValue {
  const ctx = useContext(E2eeContext);
  if (!ctx) throw new Error('useE2ee must be used within E2eeProvider');
  return ctx;
}

/** Reactively decrypt a node's (ciphertext) name for display. */
export function useDecryptedName(docId: string | null, ciphertext: string): string {
  const { decryptName } = useE2ee();
  const [name, setName] = useState(ciphertext);
  useEffect(() => {
    let active = true;
    void decryptName(docId, ciphertext).then((n) => active && setName(n));
    return () => {
      active = false;
    };
  }, [docId, ciphertext, decryptName]);
  return name;
}
