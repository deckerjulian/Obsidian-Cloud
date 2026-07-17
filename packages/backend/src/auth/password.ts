import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// Argon2id with OWASP-recommended-ish parameters. @node-rs/argon2 ships
// prebuilt binaries (incl. linux-musl) so there is no node-gyp build step.
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, OPTIONS);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  // Parameters are encoded in the hash; no options needed for verification.
  return argonVerify(hash, password);
}
