/** Shared route/protocol constants used by client and server. */

export const API_BASE = '/api';

/** WebSocket mount path for the encrypted Yjs relay. */
export const WS_DOC_PATH = '/ws/doc';

/** The Yjs shared text field name inside every document's Y.Doc. */
export const YTEXT_FIELD = 'contents';

/** Maximum size of a binary attachment (plaintext bytes). Uploads travel as
 *  base64 inside JSON, so the HTTP body limit must stay ≈ 4/3 above this. */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;

/** Ask the relay to compact its stored update log once a connect replayed
 *  more than this many individual updates. */
export const COMPACT_AFTER_UPDATES = 64;

/** Authentication sources for a user account. */
export const AUTH_SOURCES = ['local', 'ldap'] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

/** Node kinds in the vault tree. */
export const NODE_KINDS = ['folder', 'file'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
