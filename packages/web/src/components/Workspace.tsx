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
import { useVaults } from '../vault/VaultContext';
import { VaultWorkspace } from '../workspace/VaultWorkspace';
import { VaultSwitcher, VaultOnboarding } from '../workspace/VaultSwitcher';
import { getThemeOverride, setThemeOverride, applyBaseTheme, type ThemeChoice } from '../workspace/appearance';

/** 'files' = the Obsidian-like vault workspace; 'legacy' = the raw tree
 *  (content outside any vault); 'admin'. */
type View = 'files' | 'admin' | 'legacy';

const E2EE_LABEL: Record<string, string> = {
  loading: 'Verschlüsselung: …',
  'not-setup': 'Verschlüsselung: nicht eingerichtet',
  locked: 'Verschlüsselung: gesperrt',
  unlocked: 'Verschlüsselung: aktiv',
};

export function Workspace() {
  const { user, logout } = useAuth();
  const { status: e2eeStatus, lock } = useE2ee();
  const { store, vaults } = useVaults();
  const online = useOnlineStatus();
  const [view, setView] = useState<View>('files');
  const [openNode, setOpenNode] = useState<TreeNodeDto | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [showEncryption, setShowEncryption] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(getThemeOverride());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Prompt to set up / unlock encryption automatically after sign-in.
  useEffect(() => {
    if (e2eeStatus === 'not-setup' || e2eeStatus === 'locked') setShowEncryption(true);
  }, [e2eeStatus]);

  const chooseTheme = (t: ThemeChoice): void => {
    setThemeOverride(t);
    setTheme(t);
    applyBaseTheme();
  };

  const modals = (
    <>
      {showAccount && (
        <Modal
          title="Konto"
          onClose={() => setShowAccount(false)}
          footer={
            <button className="oc-btn" onClick={() => setShowAccount(false)}>
              Schließen
            </button>
          }
        >
          <p>
            Angemeldet als <strong>{user?.email}</strong>
            {user?.isAdmin && <span className="oc-badge is-accent" style={{ marginLeft: 8 }}>admin</span>}
          </p>

          <div className="oc-account-section">
            <strong>Ende-zu-Ende-Verschlüsselung</strong>
            <div className="oc-faint" style={{ fontSize: 13, margin: '2px 0 8px' }}>
              {E2EE_LABEL[e2eeStatus]}
            </div>
            {e2eeStatus !== 'unlocked' && e2eeStatus !== 'loading' ? (
              <button
                className="oc-btn"
                onClick={() => {
                  setShowAccount(false);
                  setShowEncryption(true);
                }}
              >
                {e2eeStatus === 'not-setup' ? 'Verschlüsselung einrichten' : 'Entsperren'}
              </button>
            ) : (
              e2eeStatus === 'unlocked' && (
                <button className="oc-btn" onClick={() => lock()}>
                  Auf diesem Gerät sperren
                </button>
              )
            )}
          </div>

          <div className="oc-account-section">
            <strong>Darstellung</strong>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {(['vault', 'light', 'dark'] as const).map((t) => (
                <button key={t} className={`oc-btn${theme === t ? ' oc-btn-primary' : ''}`} onClick={() => chooseTheme(t)}>
                  {t === 'vault' ? 'Wie im Vault' : t === 'light' ? 'Hell' : 'Dunkel'}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {user?.isAdmin && (
              <button
                className="oc-btn"
                onClick={() => {
                  setShowAccount(false);
                  setView('admin');
                }}
              >
                Benutzerverwaltung
              </button>
            )}
            <button
              className="oc-btn"
              onClick={() => {
                setShowAccount(false);
                setShowChangePw(true);
              }}
            >
              Passwort ändern
            </button>
            <button className="oc-btn oc-btn-danger" onClick={() => void logout()}>
              Abmelden
            </button>
          </div>
        </Modal>
      )}
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
      {showEncryption && <EncryptionModal onClose={() => setShowEncryption(false)} />}
      {toast && (
        <div className="notice-container">
          <div className="notice" onClick={() => setToast(null)}>
            {toast}
          </div>
        </div>
      )}
    </>
  );

  // ── the Obsidian-like vault workspace (default) ────────────────────────────
  if (view === 'files') {
    const switcher = (
      <VaultSwitcher
        onAccount={() => setShowAccount(true)}
        onAdmin={user?.isAdmin ? () => setView('admin') : undefined}
        onLegacy={() => setView('legacy')}
        onError={setToast}
      />
    );
    return (
      <div className="oc-app-vault app-container">
        {e2eeStatus === 'unlocked' && store ? (
          <VaultWorkspace key={store.vaultId} store={store} vaultSwitcher={switcher} onError={setToast} />
        ) : e2eeStatus === 'unlocked' && vaults.length === 0 ? (
          <VaultOnboarding onLegacy={() => setView('legacy')} onAccount={() => setShowAccount(true)} onError={setToast} />
        ) : (
          <div className="oc-empty oc-locked-screen">
            <Icon name="key" size={28} />
            <p>
              {e2eeStatus === 'unlocked'
                ? 'Vault wird geladen…'
                : e2eeStatus === 'loading'
                  ? 'Lade…'
                  : 'Deine Vaults sind Ende-zu-Ende-verschlüsselt. Entsperre sie mit deiner Passphrase.'}
            </p>
            {e2eeStatus !== 'unlocked' && e2eeStatus !== 'loading' && (
              <button className="oc-btn oc-btn-primary" onClick={() => setShowEncryption(true)}>
                {e2eeStatus === 'not-setup' ? 'Verschlüsselung einrichten' : 'Entsperren'}
              </button>
            )}
            <button className="oc-btn" onClick={() => setShowAccount(true)}>
              Konto
            </button>
          </div>
        )}
        {modals}
      </div>
    );
  }

  // ── admin panel / legacy tree ──────────────────────────────────────────────
  const sidebarHidden = view !== 'legacy';
  return (
    <div className={`oc-app${sidebarHidden ? ' oc-sidebar-hidden' : ''}`}>
      <nav className="oc-ribbon">
        <button className="oc-ribbon-item" title="Vaults" onClick={() => setView('files')}>
          <Icon name="cloud" size={19} />
        </button>
        <button
          className={`oc-ribbon-item${view === 'legacy' ? ' is-active' : ''}`}
          title="Server-Baum (ohne Vault)"
          onClick={() => setView('legacy')}
        >
          <Icon name="files" size={19} />
        </button>
        {user?.isAdmin && (
          <button
            className={`oc-ribbon-item${view === 'admin' ? ' is-active' : ''}`}
            title="Benutzer"
            onClick={() => setView('admin')}
          >
            <Icon name="users" size={19} />
          </button>
        )}
        <span className="oc-ribbon-spacer" />
        <button className="oc-ribbon-item" title="Konto" onClick={() => setShowAccount(true)}>
          <Icon name="settings" size={19} />
        </button>
      </nav>

      {!sidebarHidden && (
        <aside className="oc-sidebar">
          <div className="oc-brand">
            <Icon name="cloud" size={16} />
            <span>Server-Baum</span>
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
            <div>Inhalte außerhalb eines Vaults und der zentrale Plugin-Ordner.</div>
            <div className="oc-faint">Für deine Notizen: links oben „Vaults“.</div>
          </div>
        )}
      </main>

      <footer className="oc-statusbar">
        <span className="oc-status-item">
          <span className={`oc-dot${online ? ' is-online' : ''}`} /> {online ? 'Verbunden' : 'Offline'}
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
      {modals}
    </div>
  );
}
