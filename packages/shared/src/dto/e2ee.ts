/** Register the current user's key pair (all values are opaque base64). */
export interface RegisterKeysRequest {
  publicKey: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
  /**
   * Replace an existing key pair. Without this flag the server rejects a
   * re-registration (409) — overwriting the key pair makes every content key
   * wrapped for the old public key permanently undecryptable.
   */
  force?: boolean;
}

/** `GET /api/e2ee/keys/me` — the current user's stored key material. */
export interface UserKeysDto {
  publicKey: string;
  encryptedPrivateKey: string;
  kdfSalt: string;
}

/** A user's public key, for wrapping document keys when sharing. */
export interface PublicKeyDto {
  userId: string;
  email: string;
  displayName: string;
  /** null when the user has not set up E2EE yet. */
  publicKey: string | null;
}

/**
 * `GET /api/e2ee/grantees/:docId` — the public keys of every OTHER user who
 * already has read access to this node's subtree (via inherited ACL). The
 * creator of a note in a shared folder wraps the fresh content key for these
 * users so they can read it, without a separate share step. Minimal by design
 * (no emails): these are co-grantees of a subtree the caller participates in.
 */
export interface GranteeKeyDto {
  userId: string;
  /** Always present — users without a public key are omitted from the list. */
  publicKey: string;
}

/** `GET /api/e2ee/document-keys/:docId` — the caller's wrapped content key. */
export interface DocumentKeyDto {
  docId: string;
  wrappedKey: string;
}

/** `PUT /api/e2ee/document-keys/:docId` — store wrapped keys for one or more users. */
export interface SetDocumentKeysRequest {
  entries: Array<{ userId: string; wrappedKey: string }>;
}
