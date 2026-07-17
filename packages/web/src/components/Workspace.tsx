import { useEffect, useState } from 'react';
import type { TreeNodeDto } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { FileExplorer } from './FileExplorer';
import { EditorPane } from './EditorPane';
import { AdminPanel } from '../admin/AdminPanel';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { ChangePasswordModal } from '../account/ChangePasswordModal';
import { useE2ee } from '../e2ee/E2eeContext';
import { EncryptionModal } from '../e2ee/EncryptionModal';
import { useOnlineStatus } from '../useOnlineStatus';

type View = 'files' | 'admin';

const E2EE_LABEL: Record<string, string> = {
  loading: 'Encryption: …',
  'not-setup': 'Encryption: not set up',
  locked: 'Encryption: locked',
  unlocked: 'Encryption: on',
};

export function Workspace() {
  const { user, logout } = useAuth();
  const { status: e2eeStatus } = useE2ee();
  const online = useOnlineStatus();
  const [view, setView] = useState<View>('files');
  const [openNode, setOpenNode] = useState<TreeNodeDto | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [showEncryption, setShowEncryption] = useState(false);

  // Prompt to set up / unlock encryption automatically after sign-in.
  useEffect(() => {
    if (e2eeStatus === 'not-setup' || e2eeStatus === 'locked') setShowEncryption(true);
  }, [e2eeStatus]);

  const sidebarHidden = view !== 'files';

  return (
    <div className={`oc-app${sidebarHidden ? ' oc-sidebar-hidden' : ''}`}>
      <nav className="oc-ribbon">
        <button
          className={`oc-ribbon-item${view === 'files' ? ' is-active' : ''}`}
          title="Files"
          onClick={() => setView('files')}
        >
          <Icon name="files" size={19} />
        </button>
        {user?.isAdmin && (
          <button
            className={`oc-ribbon-item${view === 'admin' ? ' is-active' : ''}`}
            title="Users"
            onClick={() => setView('admin')}
          >
            <Icon name="users" size={19} />
          </button>
        )}
        <span className="oc-ribbon-spacer" />
        <button className="oc-ribbon-item" title="Account" onClick={() => setShowAccount(true)}>
          <Icon name="settings" size={19} />
        </button>
      </nav>

      {!sidebarHidden && (
        <aside className="oc-sidebar">
          <div className="oc-brand">
            <Icon name="cloud" size={16} />
            <span>Obsidian Cloud</span>
          </div>
          <FileExplorer selectedId={openNode?.id ?? null} onOpen={(n) => setOpenNode(n)} />
        </aside>
      )}

      <main className="oc-main">
        {view === 'admin' ? (
          <AdminPanel />
        ) : openNode ? (
          <EditorPane node={openNode} onClose={() => setOpenNode(null)} />
        ) : (
          <div className="oc-empty">
            <div className="oc-empty-icon">
              <Icon name="cloud" size={44} />
            </div>
            <div>Select a note to start editing</div>
            <div className="oc-faint">Real-time, permission-aware collaboration.</div>
          </div>
        )}
      </main>

      <footer className="oc-statusbar">
        <span className="oc-status-item">
          <span className={`oc-dot${online ? ' is-online' : ''}`} /> {online ? 'Connected' : 'Offline'}
        </span>
        <span
          className="oc-status-item"
          style={{ cursor: e2eeStatus === 'unlocked' ? 'default' : 'pointer' }}
          onClick={() => e2eeStatus !== 'unlocked' && e2eeStatus !== 'loading' && setShowEncryption(true)}
        >
          <Icon name="key" size={12} /> {E2EE_LABEL[e2eeStatus]}
        </span>
        <span className="oc-status-item">
          {user?.displayName}
          {user?.isAdmin ? ' · admin' : ''}
        </span>
      </footer>

      {showAccount && (
        <Modal
          title="Account"
          onClose={() => setShowAccount(false)}
          footer={
            <button className="oc-btn" onClick={() => setShowAccount(false)}>
              Close
            </button>
          }
        >
          <p>
            Signed in as <strong>{user?.email}</strong>
            {user?.isAdmin && <span className="oc-badge is-accent" style={{ marginLeft: 8 }}>admin</span>}
          </p>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--oc-border)' }}>
            <strong>End-to-end encryption</strong>
            <div className="oc-faint" style={{ fontSize: 13, margin: '2px 0 8px' }}>
              {E2EE_LABEL[e2eeStatus]}
            </div>
            {e2eeStatus !== 'unlocked' && e2eeStatus !== 'loading' && (
              <button
                className="oc-btn"
                onClick={() => {
                  setShowAccount(false);
                  setShowEncryption(true);
                }}
              >
                {e2eeStatus === 'not-setup' ? 'Set up encryption' : 'Unlock'}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              className="oc-btn"
              onClick={() => {
                setShowAccount(false);
                setShowChangePw(true);
              }}
            >
              Change password
            </button>
            <button className="oc-btn oc-btn-danger" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </Modal>
      )}
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
      {showEncryption && <EncryptionModal onClose={() => setShowEncryption(false)} />}
    </div>
  );
}
