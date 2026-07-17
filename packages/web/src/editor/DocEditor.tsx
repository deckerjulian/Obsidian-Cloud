import { useCallback, useEffect, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import type { TreeNodeDto, DocumentBootstrapDto } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useDecryptedName } from '../e2ee/E2eeContext';
import { useYDoc } from './useYDoc';
import { Editor } from './Editor';
import { MarkdownToolbar } from './MarkdownToolbar';
import { renderMarkdown } from './renderMarkdown';
import { presenceFor } from './presence';
import { Icon } from '../components/Icon';

/** Text note pane: title bar + formatting toolbar + collaborative editor / preview. */
export function DocEditor({ node, onClose }: { node: TreeNodeDto; onClose: () => void }) {
  const { authFetch, user } = useAuth();
  const docId = node.docId as string;
  const { ytext, provider, awareness, synced, keyState } = useYDoc(docId);
  const title = useDecryptedName(node.docId, node.name);
  const [writable, setWritable] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [view, setView] = useState<EditorView | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');

  useEffect(() => {
    let active = true;
    authFetch<DocumentBootstrapDto>(`/documents/${docId}/bootstrap`)
      .then((b) => active && setWritable(b.writable))
      .catch(() => active && setWritable(false));
    return () => {
      active = false;
    };
  }, [authFetch, docId]);

  useEffect(() => {
    if (!awareness || !user) return;
    awareness.setLocalStateField('user', presenceFor(user.id, user.displayName));
  }, [awareness, user]);

  // Keep the preview in sync with the (live) document while it's shown.
  useEffect(() => {
    if (mode !== 'preview') return;
    const update = () => setPreviewHtml(renderMarkdown(ytext.toString()));
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [mode, ytext]);

  const handleView = useCallback((v: EditorView | null) => setView(v), []);

  return (
    <>
      <div className="oc-titlebar">
        <div className="oc-titlebar-title">
          <Icon name="file" size={15} />
          <span>{title}</span>
          <span className="oc-badge" title="End-to-end encrypted">
            <Icon name="key" size={11} /> e2ee
          </span>
          {keyState === 'ok' && !writable && <span className="oc-badge is-warn">read-only</span>}
        </div>
        <div className="oc-titlebar-actions">
          {keyState === 'ok' && (
            <span className="oc-status-item oc-faint">
              <span className={`oc-dot${synced ? ' is-online' : ''}`} />
              {synced ? 'live' : 'connecting…'}
            </span>
          )}
          <button className="oc-btn oc-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {keyState === 'ok' && provider && (
        <MarkdownToolbar
          view={view}
          mode={mode}
          onToggleMode={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
          disabled={!writable}
        />
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {keyState === 'ok' && provider ? (
          mode === 'edit' ? (
            <Editor ytext={ytext} awareness={awareness} readOnly={!writable} onView={handleView} />
          ) : (
            <div className="oc-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          )
        ) : keyState === 'locked' ? (
          <div className="oc-empty">
            <Icon name="key" size={24} />
            <p>This vault is end-to-end encrypted.</p>
            <p className="oc-faint">Unlock encryption (status bar, bottom) to view this note.</p>
          </div>
        ) : keyState === 'no-key' ? (
          <div className="oc-empty">
            <Icon name="key" size={24} />
            <p>No encryption key for this note.</p>
            <p className="oc-faint">
              It was created before encryption was enabled, or has not been shared with you yet.
            </p>
          </div>
        ) : (
          <div className="oc-empty">Decrypting…</div>
        )}
      </div>
    </>
  );
}
