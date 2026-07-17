import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { accountApi } from '../api/endpoints';
import { Modal } from '../components/Modal';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountApi(authFetch), [authFetch]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={
        done ? (
          <button className="oc-btn oc-btn-accent" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="oc-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              className="oc-btn oc-btn-accent"
              disabled={busy || current.length < 1 || next.length < 8}
              onClick={() => void submit()}
            >
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p>Your password has been updated.</p>
      ) : (
        <>
          {error && <div className="oc-error">{error}</div>}
          <div className="oc-field">
            <label>Current password</label>
            <input
              className="oc-input"
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="oc-field">
            <label>New password (min 8 characters)</label>
            <input
              className="oc-input"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
        </>
      )}
    </Modal>
  );
}
