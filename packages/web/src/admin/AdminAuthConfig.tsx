import { useEffect, useMemo, useState } from 'react';
import type { AuthConfigDto } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { authConfigApi } from '../api/endpoints';

type LdapText =
  | 'url'
  | 'bindDn'
  | 'searchBase'
  | 'searchFilter'
  | 'attrEmail'
  | 'attrDisplayName'
  | 'adminGroup';

interface LdapForm {
  url: string;
  bindDn: string;
  searchBase: string;
  searchFilter: string;
  attrEmail: string;
  attrDisplayName: string;
  adminGroup: string;
  tls: boolean;
}

export function AdminAuthConfig() {
  const { authFetch } = useAuth();
  const api = useMemo(() => authConfigApi(authFetch), [authFetch]);

  const [cfg, setCfg] = useState<AuthConfigDto | null>(null);
  const [localEnabled, setLocalEnabled] = useState(true);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [ldap, setLdap] = useState<LdapForm>({
    url: '',
    bindDn: '',
    searchBase: '',
    searchFilter: '',
    attrEmail: '',
    attrDisplayName: '',
    adminGroup: '',
    tls: false,
  });
  const [bindCredentials, setBindCredentials] = useState('');
  const [bindSet, setBindSet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get()
      .then((c) => {
        if (!active) return;
        setCfg(c);
        setLocalEnabled(c.providers.includes('local'));
        setLdapEnabled(c.providers.includes('ldap'));
        setLdap({
          url: c.ldap.url,
          bindDn: c.ldap.bindDn,
          searchBase: c.ldap.searchBase,
          searchFilter: c.ldap.searchFilter,
          attrEmail: c.ldap.attrEmail,
          attrDisplayName: c.ldap.attrDisplayName,
          adminGroup: c.ldap.adminGroup,
          tls: c.ldap.tls,
        });
        setBindSet(c.ldap.bindCredentialsSet);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      active = false;
    };
  }, [api]);

  async function save() {
    setBusy(true);
    setError(null);
    setMsg(null);
    const providers: string[] = ['local'];
    if (ldapEnabled) providers.push('ldap');
    try {
      const updated = await api.update({
        providers,
        ldap: { ...ldap, ...(bindCredentials ? { bindCredentials } : {}) },
      });
      setBindSet(updated.ldap.bindCredentialsSet);
      setBindCredentials('');
      setMsg('Configuration saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return <p className="oc-faint">Loading…</p>;

  const textField = (label: string, key: LdapText, placeholder?: string) => (
    <div className="oc-field">
      <label>{label}</label>
      <input
        className="oc-input"
        value={ldap[key]}
        placeholder={placeholder}
        onChange={(e) => setLdap({ ...ldap, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <>
      <h2 className="oc-section-title">Authentication</h2>
      <p className="oc-faint">
        Choose which sign-in providers are enabled and configure the LDAP / Active Directory
        connection. Local password login is always available so an admin can sign in.
      </p>
      {error && <div className="oc-error">{error}</div>}
      {msg && <div style={{ color: 'var(--oc-green)', margin: '6px 0' }}>{msg}</div>}

      <div className="oc-field">
        <label>Providers</label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: 0.7 }}>
          <input type="checkbox" checked disabled /> Local (password) — always on
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={ldapEnabled} onChange={(e) => setLdapEnabled(e.target.checked)} />{' '}
          LDAP / Active Directory
        </label>
      </div>

      <h3 style={{ marginTop: 18, marginBottom: 6 }}>LDAP / Active Directory</h3>
      {textField('Server URL', 'url', 'ldap://host:389 or ldaps://host:636')}
      {textField('Bind DN (service account)', 'bindDn', 'cn=admin,dc=example,dc=org')}
      <div className="oc-field">
        <label>
          Bind password{' '}
          {bindSet && <span className="oc-faint">(stored — leave empty to keep current)</span>}
        </label>
        <input
          className="oc-input"
          type="password"
          placeholder={bindSet ? '••••••••' : ''}
          value={bindCredentials}
          onChange={(e) => setBindCredentials(e.target.value)}
        />
      </div>
      {textField('Search base', 'searchBase', 'ou=people,dc=example,dc=org')}
      {textField('Search filter', 'searchFilter', '(uid={{username}})')}
      {textField('Email attribute', 'attrEmail', 'mail')}
      {textField('Display-name attribute', 'attrDisplayName', 'cn')}
      {textField('Admin group DN (optional)', 'adminGroup')}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 16px' }}>
        <input type="checkbox" checked={ldap.tls} onChange={(e) => setLdap({ ...ldap, tls: e.target.checked })} />{' '}
        Use StartTLS
      </label>

      <button className="oc-btn oc-btn-accent" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save configuration'}
      </button>
    </>
  );
}
