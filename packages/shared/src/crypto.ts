/**
 * Isomorphic E2EE primitives built on the Web Crypto API (available in the
 * browser, Electron/Obsidian and Node 19+). The server never imports this —
 * it only ever stores the opaque base64 strings these functions produce.
 *
 * Scheme:
 *  - Each user has an RSA-OAEP key pair. The private key is exported (PKCS8) and
 *    AES-GCM-wrapped with a key derived from the user's E2EE passphrase
 *    (PBKDF2). Only the wrapped private key + public key + salt reach the server.
 *  - Each document has a random AES-256-GCM content key. It is wrapped (RSA-OAEP)
 *    for every authorised user's public key.
 *  - Content, file names and blobs are AES-GCM encrypted with the content key.
 */

const subtle = globalThis.crypto.subtle;

/** Cast a Uint8Array to BufferSource for the Web Crypto API (TS 5.7+ widens the
 *  default Uint8Array buffer type, which the lib types reject otherwise). */
function bs(v: Uint8Array): BufferSource {
  return v as unknown as BufferSource;
}

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};
const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;

// ── user key pair ────────────────────────────────────────────────────────────
export function generateUserKeyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']) as Promise<CryptoKeyPair>;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await subtle.exportKey('spki', key)));
}

export function importPublicKey(b64: string): Promise<CryptoKey> {
  return subtle.importKey('spki', bs(fromBase64(b64)), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [
    'encrypt',
  ]);
}

/**
 * A short, human-comparable fingerprint of a user's public key (SHA-256 of the
 * SPKI bytes, first 16 bytes as grouped hex). The server can substitute a
 * public key during sharing; showing/pinning this lets clients detect that.
 */
export async function fingerprintPublicKey(spkiB64: string): Promise<string> {
  const digest = await subtle.digest('SHA-256', bs(fromBase64(spkiB64)));
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return (hex.match(/.{4}/g) ?? []).join(' ');
}

export function newSalt(): string {
  return toBase64(randomBytes(SALT_BYTES));
}

/** Derive an AES-GCM key from the E2EE passphrase + salt (PBKDF2). */
export async function deriveWrappingKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', bs(new TextEncoder().encode(passphrase)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(fromBase64(saltB64)), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

export async function wrapPrivateKey(privateKey: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const wrapped = await subtle.wrapKey('pkcs8', privateKey, wrappingKey, { name: 'AES-GCM', iv: bs(iv) });
  return toBase64(concat(iv, new Uint8Array(wrapped)));
}

/** Everything a first-time E2EE setup produces. */
export interface NewUserKeys {
  /** Upload these three to the server. */
  publicKeyB64: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
  /** Working copies for this device. The private key is NON-extractable. */
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/**
 * First-time setup: generate the user key pair and wrap the private key with
 * the passphrase. The extractable original (needed once for wrapKey) is
 * dropped here — callers only ever get a non-extractable working copy, exactly
 * like the unlock path produces. Persisting an extractable private key would
 * let any injected script export and exfiltrate it.
 */
export async function createUserKeys(passphrase: string): Promise<NewUserKeys> {
  const kp = await generateUserKeyPair();
  const kdfSalt = newSalt();
  const wrappingKey = await deriveWrappingKey(passphrase, kdfSalt);
  const encryptedPrivateKey = await wrapPrivateKey(kp.privateKey, wrappingKey);
  const publicKeyB64 = await exportPublicKey(kp.publicKey);
  const privateKey = await unwrapPrivateKey(encryptedPrivateKey, wrappingKey);
  return { publicKeyB64, encryptedPrivateKey, kdfSalt, privateKey, publicKey: kp.publicKey };
}

export async function unwrapPrivateKey(b64: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const data = fromBase64(b64);
  const iv = data.subarray(0, IV_BYTES);
  const wrapped = data.subarray(IV_BYTES);
  return subtle.unwrapKey(
    'pkcs8',
    bs(wrapped),
    wrappingKey,
    { name: 'AES-GCM', iv: bs(iv) },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
}

// ── document content keys ────────────────────────────────────────────────────
export function generateContentKey(): Promise<CryptoKey> {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function wrapContentKeyForUser(
  contentKey: CryptoKey,
  userPublicKey: CryptoKey,
): Promise<string> {
  const raw = await subtle.exportKey('raw', contentKey);
  const enc = await subtle.encrypt({ name: 'RSA-OAEP' }, userPublicKey, raw);
  return toBase64(new Uint8Array(enc));
}

export async function unwrapContentKey(b64: string, userPrivateKey: CryptoKey): Promise<CryptoKey> {
  const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, userPrivateKey, bs(fromBase64(b64)));
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

// ── content encryption ───────────────────────────────────────────────────────
/**
 * What a ciphertext is FOR. Bound as AES-GCM additional authenticated data so
 * that, under one content key, a name, a blob, a Yjs update and an awareness
 * frame are NOT interchangeable — the relay/server can't swap one for another
 * (e.g. re-type an awareness frame as a document update) without failing the
 * GCM authentication check.
 */
export type CryptoPurpose = 'name' | 'blob' | 'yupdate' | 'awareness';

/** Envelope version marker for AAD-bound ciphertext: `[0x01][iv][ct+tag]`.
 *  Legacy ciphertext has no marker (`[iv][ct+tag]`, no AAD) and is still read
 *  via the fallback in decryptBytes — no data migration needed. */
const CIPHER_V1 = 0x01;

function gcmParams(iv: Uint8Array, purpose?: CryptoPurpose): AesGcmParams {
  const params: AesGcmParams = { name: 'AES-GCM', iv: bs(iv) };
  if (purpose) params.additionalData = bs(new TextEncoder().encode(purpose));
  return params;
}

export async function encryptBytes(
  contentKey: CryptoKey,
  data: Uint8Array,
  purpose?: CryptoPurpose,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt(gcmParams(iv, purpose), contentKey, bs(data)));
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = CIPHER_V1;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export async function decryptBytes(
  contentKey: CryptoKey,
  blob: Uint8Array,
  purpose?: CryptoPurpose,
): Promise<Uint8Array> {
  // v1 envelope: version byte + purpose-bound ciphertext.
  if (blob[0] === CIPHER_V1 && blob.length > 1 + IV_BYTES) {
    try {
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const ct = blob.subarray(1 + IV_BYTES);
      return new Uint8Array(await subtle.decrypt(gcmParams(iv, purpose), contentKey, bs(ct)));
    } catch {
      /* not a v1 frame after all (legacy blob starting with 0x01) — fall back */
    }
  }
  // Legacy: [iv][ct+tag], no version byte, no AAD.
  const iv = blob.subarray(0, IV_BYTES);
  const ct = blob.subarray(IV_BYTES);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(iv) }, contentKey, bs(ct)));
}

export async function encryptString(
  contentKey: CryptoKey,
  text: string,
  purpose?: CryptoPurpose,
): Promise<string> {
  return toBase64(await encryptBytes(contentKey, new TextEncoder().encode(text), purpose));
}

export async function decryptString(
  contentKey: CryptoKey,
  b64: string,
  purpose?: CryptoPurpose,
): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(contentKey, fromBase64(b64), purpose));
}
