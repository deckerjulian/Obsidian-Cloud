import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { TreeNodeDto, BlobContentDto } from '@oc/shared';
import { hasCapability, MAX_BLOB_BYTES } from '@oc/shared';
import * as e2 from '@oc/shared/crypto';
import { useAuth } from '../auth/AuthContext';
import { useE2ee, useDecryptedName } from '../e2ee/E2eeContext';
import { ApiError } from '../api/http';
import { Icon } from '../components/Icon';

/** Binary file pane: title bar + image preview / download / replace upload.
 *  Content is AES-GCM encrypted with the document's content key — the server
 *  only stores ciphertext. */
export function BlobView({ node, onClose }: { node: TreeNodeDto; onClose: () => void }) {
  const { authFetch } = useAuth();
  const { status, getContentKey } = useE2ee();
  const title = useDecryptedName(node.docId, node.name);
  const docId = node.docId as string;
  // Use the capability, not the display role: a create-only grant is labelled
  // "editor" but the server requires 'edit' to write — so canWrite(role) shows
  // an upload UI that then 403s.
  const writable = hasCapability(node.capabilities, 'edit');
  const [blob, setBlob] = useState<{ url: string; size: number; mime: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  // Track the live object URL so it's revoked on replace/unmount (otherwise the
  // blob memory leaks for every file switch until the page unloads).
  const objectUrl = useRef<string | null>(null);
  const setBlobUrl = useCallback((next: { url: string; size: number; mime: string | null } | null) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = next?.url ?? null;
    setBlob(next);
  }, []);

  const load = useCallback(async () => {
    if (status === 'loading') return;
    setLocked(false);
    if (status !== 'unlocked') {
      setBlobUrl(null);
      setLocked(true);
      return;
    }
    try {
      const contentKey = await getContentKey(docId);
      let b: BlobContentDto;
      try {
        b = await authFetch<BlobContentDto>(`/documents/${docId}/blob`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setBlobUrl(null);
          setError(null); // simply no content uploaded yet
          return;
        }
        throw e;
      }
      if (!contentKey) {
        setBlobUrl(null);
        setError('No encryption key for this file — it has not been shared with you.');
        return;
      }
      const bytes = await e2.decryptBytes(contentKey, e2.fromBase64(b.contentBase64), 'blob');
      const url = URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: b.mime ?? 'application/octet-stream' }),
      );
      setBlobUrl({ url, size: bytes.length, mime: b.mime });
      setError(null);
    } catch (e) {
      setBlobUrl(null);
      setError((e as Error).message);
    }
  }, [authFetch, docId, getContentKey, status, setBlobUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // Revoke the last object URL when the pane unmounts / switches file.
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    },
    [],
  );

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BLOB_BYTES) {
      setError(`File is too large to sync (max ${Math.round(MAX_BLOB_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    try {
      const contentKey = await getContentKey(docId);
      // Do NOT mint a fresh key when none is available: this node's name (and
      // any prior content) was encrypted with the original key, so a new one
      // would fork the doc — its name becomes undecryptable for us and other
      // holders can't read the new blob. A missing key means it wasn't shared.
      if (!contentKey) {
        setError(
          status !== 'unlocked'
            ? 'Unlock encryption first.'
            : 'No encryption key for this file — it has not been shared with you.',
        );
        return;
      }
      const cipher = await e2.encryptBytes(contentKey, new Uint8Array(await file.arrayBuffer()), 'blob');
      await authFetch(`/documents/${docId}/blob`, {
        method: 'PUT',
        body: { contentBase64: e2.toBase64(cipher), mime: file.type || undefined },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const isImage = blob?.mime?.startsWith('image/');

  return (
    <>
      <div className="oc-titlebar">
        <div className="oc-titlebar-title">
          <Icon name="image" size={15} />
          <span>{title}</span>
          <span className="oc-badge" title="End-to-end encrypted">
            <Icon name="key" size={11} /> e2ee
          </span>
          {!writable && <span className="oc-badge is-warn">read-only</span>}
        </div>
        <div className="oc-titlebar-actions">
          <button className="oc-btn oc-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="oc-content">
        <div className="oc-content-pad">
          {error && <div className="oc-error">{error}</div>}
          {locked ? (
            <p className="oc-faint">Unlock encryption (status bar, bottom) to view this file.</p>
          ) : blob ? (
            <>
              {isImage && (
                <img
                  src={blob.url}
                  alt={title}
                  style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--oc-border)' }}
                />
              )}
              <p>
                <a
                  className="oc-btn"
                  href={blob.url}
                  download={title}
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="download" size={15} /> Download ({blob.size.toLocaleString()} bytes)
                </a>
              </p>
            </>
          ) : (
            !error && <p className="oc-faint">No content uploaded yet.</p>
          )}
          {writable && !locked && (
            <div style={{ marginTop: 16 }}>
              <label className="oc-faint">Replace contents </label>
              <input type="file" onChange={(e) => void onUpload(e)} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
