import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserDto } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { usersApi } from '../api/endpoints';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icon';

function CreateUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { authFetch } = useAuth();
  const api = useMemo(() => usersApi(authFetch), [authFetch]);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPluginAdmin, setIsPluginAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.create({ email: email.trim(), displayName: displayName.trim(), password, isAdmin, isPluginAdmin });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New user"
      onClose={onClose}
      footer={
        <>
          <button className="oc-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="oc-btn oc-btn-accent" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </>
      }
    >
      {error && <div className="oc-error">{error}</div>}
      <div className="oc-field">
        <label>Email</label>
        <input className="oc-input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="oc-field">
        <label>Display name</label>
        <input className="oc-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="oc-field">
        <label>Password (min 8 characters)</label>
        <input
          className="oc-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        Administrator
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
        <input type="checkbox" checked={isPluginAdmin} onChange={(e) => setIsPluginAdmin(e.target.checked)} />
        Plugin admin (may change vaults' Obsidian plugins and settings in the cloud)
      </label>
    </Modal>
  );
}

export function AdminUsers() {
  const { authFetch, user: me } = useAuth();
  const api = useMemo(() => usersApi(authFetch), [authFetch]);
  const [users, setUsers] = useState<UserDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const reload = useCallback(async () => {
    try {
      setUsers(await api.list());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
    } catch (e) {
      window.alert((e as Error).message);
    }
  }

  function resetPassword(u: UserDto) {
    const pw = window.prompt(`New password for ${u.email} (min 8 characters)`);
    if (!pw) return;
    void api
      .update(u.id, { password: pw })
      .then(() => window.alert('Password updated.'))
      .catch((e: Error) => window.alert(e.message));
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="oc-section-title">Users</h2>
        <button
          className="oc-btn oc-btn-accent"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          onClick={() => setShowCreate(true)}
        >
          <Icon name="plus" size={15} /> New user
        </button>
      </div>
      <p className="oc-faint" style={{ marginTop: 4 }}>
        Local users sign in with a password; directory (LDAP) users are provisioned on first login.
        “Plugins in the cloud”: who may change a vault’s Obsidian plugins, their settings and themes on the
        server (admins always; others only as plugin admin). Everyone else uses the plugins as set up.
      </p>
      {error && <div className="oc-error">{error}</div>}

      <table className="oc-table" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Source</th>
            <th>Role</th>
            <th title="May change vaults' Obsidian plugins, their settings and themes in the cloud (the vault's .obsidian folder). Admins always can.">
              Plugins in the cloud
            </th>
            <th style={{ textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.displayName}
                {u.id === me?.id && <span className="oc-faint"> (you)</span>}
              </td>
              <td className="oc-muted">{u.email}</td>
              <td>
                <span className="oc-badge">{u.authSource}</span>
              </td>
              <td>
                {u.isAdmin ? (
                  <span className="oc-badge is-accent">admin</span>
                ) : (
                  <span className="oc-badge">user</span>
                )}
              </td>
              <td>
                <label
                  className="oc-plugin-admin-toggle"
                  title={
                    u.isAdmin
                      ? 'Admins can always manage plugins.'
                      : u.isPluginAdmin
                        ? 'Plugin admin — click to revoke.'
                        : 'Make this user a plugin admin.'
                  }
                >
                  <input
                    type="checkbox"
                    checked={u.isAdmin || u.isPluginAdmin}
                    disabled={u.isAdmin}
                    onChange={() => void act(() => api.update(u.id, { isPluginAdmin: !u.isPluginAdmin }))}
                  />
                  <span className={u.isAdmin ? 'oc-faint' : ''}>
                    {u.isAdmin ? 'always (admin)' : u.isPluginAdmin ? 'plugin admin' : 'no'}
                  </span>
                </label>
              </td>
              <td>
                <div className="oc-row-actions">
                  {/* Revoking your own admin is a lockout risk (and the server
                      blocks demoting the last admin) — hide it for yourself. */}
                  {!(u.id === me?.id && u.isAdmin) && (
                    <button
                      className="oc-btn oc-btn-sm"
                      onClick={() => void act(() => api.update(u.id, { isAdmin: !u.isAdmin }))}
                    >
                      {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                    </button>
                  )}
                  {u.authSource === 'local' && (
                    <button className="oc-btn oc-btn-sm" onClick={() => resetPassword(u)}>
                      Reset password
                    </button>
                  )}
                  {u.id !== me?.id && (
                    <button
                      className="oc-btn oc-btn-sm oc-btn-danger"
                      onClick={() => {
                        if (window.confirm(`Delete user ${u.email}?`)) void act(() => api.remove(u.id));
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void reload();
          }}
        />
      )}
    </>
  );
}
