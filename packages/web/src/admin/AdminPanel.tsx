import { useState } from 'react';
import { AdminUsers } from './AdminUsers';
import { AdminAuthConfig } from './AdminAuthConfig';

export function AdminPanel() {
  const [tab, setTab] = useState<'users' | 'auth'>('users');
  return (
    <div className="oc-content">
      <div className="oc-content-pad">
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 18,
            borderBottom: '1px solid var(--oc-border)',
            paddingBottom: 12,
          }}
        >
          <button
            className={`oc-btn${tab === 'users' ? ' oc-btn-accent' : ''}`}
            onClick={() => setTab('users')}
          >
            Users
          </button>
          <button
            className={`oc-btn${tab === 'auth' ? ' oc-btn-accent' : ''}`}
            onClick={() => setTab('auth')}
          >
            Authentication
          </button>
        </div>
        {tab === 'users' ? <AdminUsers /> : <AdminAuthConfig />}
      </div>
    </div>
  );
}
