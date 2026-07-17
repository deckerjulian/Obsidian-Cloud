import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { EncryptedProvider } from '@oc/shared/yjs-provider';
import { WS_DOC_PATH, YTEXT_FIELD } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useE2ee } from '../e2ee/E2eeContext';

function wsBase(): string {
  // When the API lives on another origin (VITE_API_BASE), use it for the
  // WebSocket too; otherwise stay same-origin (behind the reverse proxy).
  const apiBase = import.meta.env.VITE_API_BASE;
  if (apiBase) return apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

export type DocKeyState = 'ok' | 'loading' | 'locked' | 'no-key';

/**
 * Y.Doc + end-to-end-encrypted relay provider + IndexedDB cache for one document.
 * Content (and awareness) is AES-GCM encrypted with the per-document key before
 * it reaches the server; the key is unwrapped locally via the E2EE context.
 */
export function useYDoc(docId: string) {
  const { getFreshAccessToken } = useAuth();
  const { status, getContentKey } = useE2ee();
  const ydoc = useMemo(() => new Y.Doc(), [docId]);
  const ytext = useMemo(() => ydoc.getText(YTEXT_FIELD), [ydoc]);
  const [provider, setProvider] = useState<EncryptedProvider | null>(null);
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const [synced, setSynced] = useState(false);
  const [keyState, setKeyState] = useState<DocKeyState>('loading');

  useEffect(() => {
    setSynced(false);
    setProvider(null);
    setAwareness(null);
    if (status === 'loading') {
      setKeyState('loading');
      return;
    }
    if (status !== 'unlocked') {
      setKeyState('locked');
      return;
    }

    let cancelled = false;
    let prov: EncryptedProvider | null = null;
    let aw: Awareness | null = null;
    setKeyState('loading');
    const idb = new IndexeddbPersistence(`oc-${docId}`, ydoc);

    void (async () => {
      let contentKey: CryptoKey | null = null;
      try {
        contentKey = await getContentKey(docId);
      } catch {
        contentKey = null;
      }
      if (cancelled) return;
      if (!contentKey) {
        setKeyState('no-key');
        return;
      }
      aw = new Awareness(ydoc);
      prov = new EncryptedProvider({
        url: `${wsBase()}${WS_DOC_PATH}`,
        docId,
        doc: ydoc,
        contentKey,
        awareness: aw,
        // WS reconnects have no 401-retry path; refresh a stale token here so
        // an idle editor doesn't get stuck retrying with an expired token.
        getToken: () => getFreshAccessToken(),
        onSynced: () => setSynced(true),
      });
      setAwareness(aw);
      setProvider(prov);
      setKeyState('ok');
    })();

    return () => {
      cancelled = true;
      prov?.destroy();
      aw?.destroy();
      void idb.destroy();
    };
  }, [docId, ydoc, status, getContentKey, getFreshAccessToken]);

  return { ydoc, ytext, provider, awareness, synced, keyState };
}
