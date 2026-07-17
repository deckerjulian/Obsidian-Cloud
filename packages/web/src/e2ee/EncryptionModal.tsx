import { useState } from 'react';
import { useE2ee } from './E2eeContext';
import { Modal } from '../components/Modal';

export function EncryptionModal({ onClose }: { onClose: () => void }) {
  const { status, setup, unlock } = useE2ee();
  const isSetup = status === 'not-setup';
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (passphrase.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (isSetup && passphrase !== confirm) {
      setError('Passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) await setup(passphrase);
      else await unlock(passphrase);
      onClose();
    } catch (e) {
      setError(isSetup ? (e as Error).message : 'Wrong passphrase, or the stored key is corrupted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isSetup ? 'Set up end-to-end encryption' : 'Unlock encryption'}
      onClose={onClose}
      footer={
        <>
          <button className="oc-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="oc-btn oc-btn-accent" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Working…' : isSetup ? 'Set up' : 'Unlock'}
          </button>
        </>
      }
    >
      {isSetup ? (
        <p className="oc-faint">
          Choose a separate <strong>encryption passphrase</strong>. It never leaves this device and
          protects your private key. <strong>If you lose it, your encrypted data cannot be
          recovered</strong> — not even by an admin.
        </p>
      ) : (
        <p className="oc-faint">Enter your encryption passphrase to unlock your vault on this device.</p>
      )}
      {error && <div className="oc-error">{error}</div>}
      <div className="oc-field">
        <label>Encryption passphrase</label>
        <input
          className="oc-input"
          type="password"
          value={passphrase}
          autoFocus
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </div>
      {isSetup && (
        <div className="oc-field">
          <label>Confirm passphrase</label>
          <input
            className="oc-input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
      )}
    </Modal>
  );
}
