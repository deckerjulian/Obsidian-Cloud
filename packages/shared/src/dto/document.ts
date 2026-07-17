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
