import type { Role } from '../roles';
import type { Capability } from '../capabilities';

/**
 * `GET /api/documents/:docId/bootstrap` — everything a client needs before
 * opening the live Yjs connection. The actual content arrives over the
 * WebSocket; this just conveys identity, type and the user's effective role.
 */
export interface DocumentBootstrapDto {
  docId: string;
  path: string;
  isText: boolean;
  mime: string | null;
  role: Role;
  capabilities: Capability[];
  /** Whether the user may edit content (UI read-only hint). */
  writable: boolean;
}

/** Metadata returned after uploading a binary (non-text) blob. */
export interface BlobInfoDto {
  docId: string;
  sha256: string;
  size: number;
  mime: string | null;
  updatedAt: string;
}

/** Upload a binary file's contents (base64; suitable for small attachments). */
export interface UploadBlobRequest {
  contentBase64: string;
  mime?: string;
}

/** Full binary contents for download. */
export interface BlobContentDto {
  docId: string;
  mime: string | null;
  sha256: string;
  size: number;
  contentBase64: string;
}

/** `POST /api/documents/updates` — fetch the encrypted Yjs update logs of
 *  several documents at once (for vault-wide indexing: search, links, plugins).
 *  The server returns only ciphertext; unreadable/unknown ids are omitted. */
export interface BatchUpdatesRequest {
  docIds: string[];
}

export interface DocUpdatesDto {
  docId: string;
  /** Encrypted Yjs updates (base64), in log order. */
  updates: string[];
  /** When the newest stored update was written (ISO) — the content mtime. */
  updatedAt: string | null;
}

export interface BatchUpdatesResponse {
  docs: DocUpdatesDto[];
}

/** `POST /api/documents/:docId/updates` — append one encrypted Yjs update
 *  (same envelope the realtime relay stores). Requires 'edit'. */
export interface AppendUpdateRequest {
  dataBase64: string;
  /** Optional original modification time (ISO, not in the future) — lets an
   *  importer keep the files' real mtimes instead of "imported just now". */
  mtime?: string;
}

/** Max docIds per batch request. */
export const MAX_BATCH_UPDATES = 200;
