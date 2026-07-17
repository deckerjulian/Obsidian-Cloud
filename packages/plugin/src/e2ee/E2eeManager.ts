import * as e2 from '@oc/shared/crypto';
import type { UserKeysDto, DocumentKeyDto, GranteeKeyDto } from '@oc/shared';
import { HttpClient, HttpError } from '../api/HttpClient';
import { saveKeys, loadKeys, clearKeys } from './keyStore';

export type E2eeStatus = 'not-setup' | 'locked' | 'unlocked';

/**
 * Holds the user's E2EE key material in memory (never persisted) and unwraps
 * per-document content keys locally. The server only ever sees ciphertext.
 */
export class E2eeManager {
  private privateKey: CryptoKey | null = null;
  private publicKey: CryptoKey | null = null;
  private readonly cache = new Map<string, CryptoKey>();
  /** Bulk-fetched wrapped keys (docId → wrappedKey), unwrapped on demand. */
  private wrappedKeys: Map<string, string> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly getUserId: () => string | null,
  ) {}

  get unlocked(): boolean {
    return this.privateKey !== null;
  }

  /** Reuse a key pair persisted on this device (no passphrase prompt). */
  async tryRestore(): Promise<boolean> {
    if (this.privateKey) return true;
    const userId = this.getUserId();
    if (!userId) return false;
    const stored = await loadKeys(userId);
    if (!stored) return false;
    this.privateKey = stored.privateKey;
    this.publicKey = stored.publicKey;
    return true;
  }

  /** Whether the account has keys registered yet, and if they're unlocked here. */
  async status(): Promise<E2eeStatus> {
    if (this.privateKey) return 'unlocked';
    try {
      await this.http.get<UserKeysDto>('/e2ee/keys/me');
      return 'locked';
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return 'not-setup';
      return 'locked';
    }
  }

  /** First-time setup: generate a key pair protected by the passphrase. Only
   *  the non-extractable working copy is kept/persisted (see createUserKeys). */
  async setup(passphrase: string): Promise<void> {
    const keys = await e2.createUserKeys(passphrase);
    await this.http.post('/e2ee/keys', {
      publicKey: keys.publicKeyB64,
      encryptedPrivateKey: keys.encryptedPrivateKey,
      kdfSalt: keys.kdfSalt,
    });
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    await this.persist(keys.privateKey, keys.publicKey);
  }

  /** Unlock the stored private key with the passphrase (throws if wrong). */
  async unlock(passphrase: string): Promise<void> {
    const keys = await this.http.get<UserKeysDto>('/e2ee/keys/me');
    const wrappingKey = await e2.deriveWrappingKey(passphrase, keys.kdfSalt);
    const priv = await e2.unwrapPrivateKey(keys.encryptedPrivateKey, wrappingKey);
    const pub = await e2.importPublicKey(keys.publicKey);
    this.privateKey = priv;
    this.publicKey = pub;
    await this.persist(priv, pub);
  }

  private async persist(privateKey: CryptoKey, publicKey: CryptoKey): Promise<void> {
    const userId = this.getUserId();
    if (userId) await saveKeys(userId, { privateKey, publicKey });
  }

  lock(): void {
    const userId = this.getUserId();
    if (userId) void clearKeys(userId);
    this.privateKey = null;
    this.publicKey = null;
    this.cache.clear();
    this.wrappedKeys = null;
  }

  /**
   * Fetch ALL of the user's wrapped keys in one request so a reconcile does not
   * issue one HTTP request per node (that N+1 also trips the server-side rate
   * limit on large vaults). Falls back silently to per-document fetches when
   * the server does not support the bulk route yet.
   */
  async primeKeyCache(): Promise<void> {
    if (!this.privateKey) return;
    try {
      const list = await this.http.get<DocumentKeyDto[]>('/e2ee/document-keys');
      this.wrappedKeys = new Map(list.map((k) => [k.docId, k.wrappedKey]));
    } catch {
      this.wrappedKeys = null;
    }
  }

  /** Fetch + unwrap the content key for a document, or null if none/locked. */
  async getContentKey(docId: string): Promise<CryptoKey | null> {
    if (!this.privateKey) return null;
    const cached = this.cache.get(docId);
    if (cached) return cached;
    try {
      const preloaded = this.wrappedKeys?.get(docId);
      const wrappedKey =
        preloaded ??
        (await this.http.get<DocumentKeyDto>(`/e2ee/document-keys/${docId}`)).wrappedKey;
      const key = await e2.unwrapContentKey(wrappedKey, this.privateKey);
      this.cache.set(docId, key);
      return key;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /** Generate a fresh content key + encrypt a node name with it (for create). */
  async prepareName(plaintext: string): Promise<{ encryptedName: string; contentKey: CryptoKey }> {
    const contentKey = await e2.generateContentKey();
    return { encryptedName: await e2.encryptString(contentKey, plaintext, 'name'), contentKey };
  }

  /** Wrap + store a content key for a (just-created) document, for this user. */
  async storeContentKey(docId: string, contentKey: CryptoKey): Promise<void> {
    const userId = this.getUserId();
    if (!this.publicKey || !userId) throw new Error('Encryption is locked');
    const wrappedKey = await e2.wrapContentKeyForUser(contentKey, this.publicKey);
    await this.http.put(`/e2ee/document-keys/${docId}`, { entries: [{ userId, wrappedKey }] });
    this.cache.set(docId, contentKey);
  }

  /**
   * Fan a new node's content key out to everyone who already has access to the
   * folder it was created in, so notes/plugins created in a shared folder are
   * readable by existing grantees without a separate share. Best-effort.
   */
  async keyForGrantees(docId: string, contentKey: CryptoKey): Promise<number> {
    let grantees: GranteeKeyDto[];
    try {
      grantees = await this.http.get<GranteeKeyDto[]>(`/e2ee/grantees/${docId}`);
    } catch {
      return 0;
    }
    if (grantees.length === 0) return 0;
    const entries: Array<{ userId: string; wrappedKey: string }> = [];
    for (const g of grantees) {
      const targetKey = await e2.importPublicKey(g.publicKey);
      entries.push({ userId: g.userId, wrappedKey: await e2.wrapContentKeyForUser(contentKey, targetKey) });
    }
    await this.http.put(`/e2ee/document-keys/${docId}`, { entries });
    return entries.length;
  }

  /**
   * Ensure all admins hold a wrapped content key for every document THIS user
   * can decrypt (admins may read all files). Idempotent; returns the current
   * admin-set signature so the caller can skip re-running until it changes.
   * Only re-keys docs the user actually holds a key for — collectively, every
   * doc's holder(s) cover the whole vault.
   */
  async backfillAdminKeys(doneSignature: string | null): Promise<string | null> {
    if (!this.privateKey) return doneSignature;
    let admins: GranteeKeyDto[];
    try {
      admins = await this.http.get<GranteeKeyDto[]>('/e2ee/admin-keys');
    } catch {
      return doneSignature;
    }
    const signature = admins
      .map((a) => `${a.userId}:${a.publicKey.slice(-24)}`)
      .sort()
      .join('|');
    if (admins.length === 0 || signature === doneSignature) return signature;

    if (!this.wrappedKeys) await this.primeKeyCache();
    const mine = this.wrappedKeys;
    if (!mine) return doneSignature;
    const adminKeys = await Promise.all(
      admins.map(async (a) => ({ userId: a.userId, key: await e2.importPublicKey(a.publicKey) })),
    );

    let rekeyed = 0;
    for (const [docId, wrapped] of mine) {
      let contentKey: CryptoKey;
      try {
        contentKey = await e2.unwrapContentKey(wrapped, this.privateKey);
      } catch {
        continue; // not decryptable by us — someone else will cover it
      }
      const entries = await Promise.all(
        adminKeys.map(async (a) => ({
          userId: a.userId,
          wrappedKey: await e2.wrapContentKeyForUser(contentKey, a.key),
        })),
      );
      try {
        await this.http.put(`/e2ee/document-keys/${docId}`, { entries });
        rekeyed++;
      } catch {
        /* skip this doc; retried next signature change */
      }
    }
    void rekeyed; // count is informational; the signature gates re-runs
    return signature;
  }

  /** Wrap a document's content key for a specific set of grantees (used to
   *  distribute the central plugin folder to all users). No-op without the key. */
  async keyDocFor(docId: string, grantees: GranteeKeyDto[]): Promise<void> {
    if (grantees.length === 0) return;
    const contentKey = await this.getContentKey(docId);
    if (!contentKey) return;
    const entries = await Promise.all(
      grantees.map(async (g) => ({
        userId: g.userId,
        wrappedKey: await e2.wrapContentKeyForUser(contentKey, await e2.importPublicKey(g.publicKey)),
      })),
    );
    await this.http.put(`/e2ee/document-keys/${docId}`, { entries });
  }

  /** Encrypt a new name with an existing document's content key (rename). */
  async encryptNameFor(docId: string, plaintext: string): Promise<string | null> {
    const key = await this.getContentKey(docId);
    if (!key) return null;
    return e2.encryptString(key, plaintext, 'name');
  }

  /** Decrypt a node name; falls back to the raw value (legacy plaintext / no key). */
  async decryptName(docId: string | null, ciphertext: string): Promise<string> {
    if (!docId || ciphertext === '') return ciphertext;
    try {
      const key = await this.getContentKey(docId);
      if (!key) return ciphertext;
      return await e2.decryptString(key, ciphertext, 'name');
    } catch {
      return ciphertext;
    }
  }

  /**
   * Strict variant for sync: returns null when the name cannot be decrypted
   * (no key, network failure, tampered data). The sync engine must be able to
   * tell "decryption failed" from "this is the name" — treating ciphertext as
   * a real name would create garbage files and, worse, make previously synced
   * paths look server-deleted.
   */
  async tryDecryptName(docId: string | null, ciphertext: string): Promise<string | null> {
    if (!docId || ciphertext === '') return ciphertext;
    try {
      const key = await this.getContentKey(docId);
      if (!key) return null;
      return await e2.decryptString(key, ciphertext, 'name');
    } catch {
      return null;
    }
  }

  /** Encrypt binary attachment contents with the document's content key. */
  async encryptBlob(docId: string, data: Uint8Array): Promise<string | null> {
    const key = await this.getContentKey(docId);
    if (!key) return null;
    return e2.toBase64(await e2.encryptBytes(key, data, 'blob'));
  }

  /** Decrypt binary attachment contents; null when the key is unavailable. */
  async decryptBlob(docId: string, contentBase64: string): Promise<Uint8Array | null> {
    const key = await this.getContentKey(docId);
    if (!key) return null;
    return e2.decryptBytes(key, e2.fromBase64(contentBase64), 'blob');
  }

  /** Create a fresh content key for a new document, wrapped for this user. */
  async provisionDocumentKey(docId: string): Promise<CryptoKey | null> {
    const userId = this.getUserId();
    if (!this.publicKey || !userId) return null;
    const contentKey = await e2.generateContentKey();
    const wrappedKey = await e2.wrapContentKeyForUser(contentKey, this.publicKey);
    await this.http.put(`/e2ee/document-keys/${docId}`, {
      entries: [{ userId, wrappedKey }],
    });
    this.cache.set(docId, contentKey);
    return contentKey;
  }
}
