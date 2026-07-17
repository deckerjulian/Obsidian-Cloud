import { describe, it, expect } from 'vitest';
import * as e from '../crypto';

describe('e2ee crypto', () => {
  it('wraps the private key with a passphrase and round-trips a document key', async () => {
    const kp = await e.generateUserKeyPair();
    const salt = e.newSalt();
    const wrappingKey = await e.deriveWrappingKey('correct horse battery', salt);

    const wrappedPriv = await e.wrapPrivateKey(kp.privateKey, wrappingKey);
    const priv = await e.unwrapPrivateKey(wrappedPriv, wrappingKey);

    // wrap a content key to the public key, unwrap with the restored private key
    const contentKey = await e.generateContentKey();
    const pub = await e.importPublicKey(await e.exportPublicKey(kp.publicKey));
    const wrappedCk = await e.wrapContentKeyForUser(contentKey, pub);
    const restoredCk = await e.unwrapContentKey(wrappedCk, priv);

    const ct = await e.encryptString(contentKey, 'hello # heading');
    expect(await e.decryptString(restoredCk, ct)).toBe('hello # heading');
  });

  it('fails to unwrap the private key with the wrong passphrase', async () => {
    const kp = await e.generateUserKeyPair();
    const salt = e.newSalt();
    const right = await e.deriveWrappingKey('right', salt);
    const wrapped = await e.wrapPrivateKey(kp.privateKey, right);
    const wrong = await e.deriveWrappingKey('wrong', salt);
    await expect(e.unwrapPrivateKey(wrapped, wrong)).rejects.toBeTruthy();
  });

  it('encrypts and decrypts bytes round-trip', async () => {
    const ck = await e.generateContentKey();
    const data = new Uint8Array([1, 2, 3, 250, 251, 255, 0]);
    const blob = await e.encryptBytes(ck, data);
    expect(blob.length).toBeGreaterThan(data.length);
    expect([...(await e.decryptBytes(ck, blob))]).toEqual([...data]);
  });

  it('detects tampering (AES-GCM authentication)', async () => {
    const ck = await e.generateContentKey();
    const blob = await e.encryptBytes(ck, new TextEncoder().encode('secret'));
    blob[blob.length - 1] ^= 0xff;
    await expect(e.decryptBytes(ck, blob)).rejects.toBeTruthy();
  });

  it('binds the purpose as AAD: a name ciphertext cannot be read as a blob', async () => {
    const ck = await e.generateContentKey();
    const asName = await e.encryptBytes(ck, new TextEncoder().encode('Note.md'), 'name');
    // Right purpose round-trips…
    expect(new TextDecoder().decode(await e.decryptBytes(ck, asName, 'name'))).toBe('Note.md');
    // …a mismatched purpose fails authentication (no cross-substitution).
    await expect(e.decryptBytes(ck, asName, 'blob')).rejects.toBeTruthy();
    await expect(e.decryptBytes(ck, asName)).rejects.toBeTruthy();
  });

  it('still reads legacy (unversioned, no-AAD) ciphertext', async () => {
    // Build a genuine OLD-format blob by hand: [iv(12)][ct+tag], no version
    // byte, no AAD — exactly what earlier clients wrote.
    const ck = await e.generateContentKey();
    const raw = await crypto.subtle.exportKey('raw', ck);
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode('legacy payload');
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    const legacy = new Uint8Array(iv.length + ct.length);
    legacy.set(iv, 0);
    legacy.set(ct, iv.length);
    expect(new TextDecoder().decode(await e.decryptBytes(ck, legacy))).toBe('legacy payload');
  });
});
