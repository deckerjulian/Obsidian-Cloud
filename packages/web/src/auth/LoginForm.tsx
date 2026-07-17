import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { Icon } from '../components/Icon';

export function LoginForm() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="oc-login">
      <form className="oc-login-card" onSubmit={onSubmit}>
        <div className="oc-login-brand">
          <span className="oc-logo">
            <Icon name="cloud" size={18} />
          </span>
          Obsidian Cloud
        </div>
        <div className="oc-login-sub">Sign in to your vault</div>

        {error && <div className="oc-error">{error}</div>}

        <div className="oc-field">
          <label>Username or email</label>
          <input className="oc-input" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </div>
        <div className="oc-field">
          <label>Password</label>
          <input
            className="oc-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="oc-btn oc-btn-accent" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
