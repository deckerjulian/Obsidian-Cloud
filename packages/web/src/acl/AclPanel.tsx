import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TreeNodeDto, AclListResponse, UserDto, Role, Capability } from '@oc/shared';
import { ROLES, CAPABILITIES, capabilitiesForRole, matchesRolePreset } from '@oc/shared';
import { useAuth } from '../auth/AuthContext';
import { useE2ee, useDecryptedName } from '../e2ee/E2eeContext';
import { aclApi, usersApi, treeApi } from '../api/endpoints';
import { Modal } from '../components/Modal';

const CAP_LABEL: Record<Capability, string> = {
  read: 'Read',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  share: 'Share',
};

/** docIds of the documents (text + binary) within (and including) a node's subtree. */
function subtreeDocIds(node: TreeNodeDto, all: TreeNodeDto[]): string[] {
  const prefix = node.path === '' ? '' : `${node.path}/`;
  return all
    .filter((n) => n.docId && (n.path === node.path || n.path.startsWith(prefix)))
    .map((n) => n.docId as string);
}

export function AclPanel({ node, onClose }: { node: TreeNodeDto; onClose: () => void }) {
  const { authFetch } = useAuth();
  const { status: e2eeStatus, shareDocuments, revokeDocuments, publicKeyInfo, trustPublicKey } =
    useE2ee();
  const nodeName = useDecryptedName(node.docId, node.name);
  const acl = useMemo(() => aclApi(authFetch), [authFetch]);
  const usersClient = useMemo(() => usersApi(authFetch), [authFetch]);
  const tree = useMemo(() => treeApi(authFetch), [authFetch]);

  const [data, setData] = useState<AclListResponse | null>(null);
  const [allUsers, setAllUsers] = useState<UserDto[]>([]);
  // null = still loading / failed. Granting MUST wait for the tree: with an
  // empty node list the ACL entry would be written but zero keys shared, and
  // the grantee would silently see "no encryption key" on every note.
  const [allNodes, setAllNodes] = useState<TreeNodeDto[] | null>(null);
  const [pickUser, setPickUser] = useState('');
  const [caps, setCaps] = useState<Set<Capability>>(new Set(capabilitiesForRole('editor')));
  const [error, setError] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyInfo, setKeyInfo] = useState<{ fingerprint: string; state: 'new' | 'trusted' | 'changed' } | null>(
    null,
  );

  // Show the selected user's public-key fingerprint (and flag a key that
  // changed since we last shared — a possible server key-substitution attack).
  useEffect(() => {
    setKeyInfo(null);
    if (!pickUser || e2eeStatus !== 'unlocked') return;
    let active = true;
    void publicKeyInfo(pickUser)
      .then((info) => active && setKeyInfo(info))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [pickUser, e2eeStatus, publicKeyInfo]);

  const reload = useCallback(async () => {
    try {
      setData(await acl.list(node.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [acl, node.id]);

  useEffect(() => {
    void reload();
    void usersClient.list().then(setAllUsers).catch(() => undefined);
    void tree
      .getTree()
      .then((r) => setAllNodes(r.nodes))
      .catch(() => setError('Could not load the folder tree — close and reopen this dialog.'));
  }, [reload, usersClient, tree]);

  function toggleCap(c: Capability) {
    setCaps((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      if (next.size > 0) next.add('read'); // any access implies read
      return next;
    });
  }

  const selected = CAPABILITIES.filter((c) => caps.has(c));

  async function grant() {
    if (!pickUser || selected.length === 0 || !allNodes) return;
    if (keyInfo?.state === 'changed') {
      setError("This user's encryption key changed — verify and trust the new key before sharing.");
      return;
    }
    setBusy(true);
    setShareMsg(null);
    try {
      await acl.set(node.id, { userId: pickUser, capabilities: selected });
      const docIds = subtreeDocIds(node, allNodes);
      if (docIds.length === 0) {
        setShareMsg('Access granted.');
      } else if (e2eeStatus !== 'unlocked') {
        setShareMsg('Access granted — unlock encryption to share the note keys, then grant again.');
      } else {
        const { shared, skipped } = await shareDocuments(docIds, pickUser);
        setShareMsg(
          `Access granted; shared keys for ${shared} note(s)` +
            (skipped ? `, ${skipped} skipped (you have no key for them).` : '.'),
        );
      }
      setPickUser('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    setBusy(true);
    try {
      await acl.remove(node.id, userId);
      // Without the tree, skip key revocation rather than guessing: the ACL
      // already blocks server access; keys can be revoked on a later attempt.
      const docIds = allNodes ? subtreeDocIds(node, allNodes) : [];
      if (docIds.length) await revokeDocuments(docIds, userId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Share “${nodeName || '/'}”`} onClose={onClose}>
      {error && <div className="oc-error">{error}</div>}
      {shareMsg && (
        <div
          style={{
            background: 'var(--oc-bg-2, rgba(127,127,127,0.12))',
            border: '1px solid var(--oc-border)',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 13,
            marginBottom: 10,
          }}
        >
          {shareMsg}
        </div>
      )}

      <table className="oc-table">
        <tbody>
          {data?.entries.map((e) => (
            <tr key={e.id}>
              <td>
                {e.user?.displayName ?? e.userId}
                <div className="oc-faint" style={{ fontSize: 12 }}>{e.user?.email}</div>
              </td>
              <td>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {e.capabilities.map((c) => (
                    <span key={c} className="oc-badge">{c}</span>
                  ))}
                </div>
              </td>
              <td style={{ width: 80 }}>
                <div className="oc-row-actions">
                  <button className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => void revoke(e.userId)}>
                    Remove
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {data && data.entries.length === 0 && (
            <tr>
              <td colSpan={3} className="oc-faint">
                No direct grants. Access may be inherited from a parent folder.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 18, borderTop: '1px solid var(--oc-border)', paddingTop: 14 }}>
        <div className="oc-field">
          <label>User</label>
          <select className="oc-select" value={pickUser} onChange={(e) => setPickUser(e.target.value)}>
            <option value="">Select user…</option>
            {allUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.email})
              </option>
            ))}
          </select>
          {keyInfo && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              <span className="oc-faint">Key fingerprint: </span>
              <code>{keyInfo.fingerprint}</code>
              {keyInfo.state === 'new' && (
                <span className="oc-faint"> · new — verify it with them out of band</span>
              )}
              {keyInfo.state === 'trusted' && <span className="oc-faint"> · trusted ✓</span>}
              {keyInfo.state === 'changed' && (
                <div className="oc-error" style={{ marginTop: 6 }}>
                  This key changed since you last shared with this user. If you did not expect that,
                  it may be a server key-substitution attack — confirm the fingerprint with them
                  before trusting it.
                  <div style={{ marginTop: 6 }}>
                    <button
                      className="oc-btn oc-btn-sm oc-btn-danger"
                      onClick={() => {
                        trustPublicKey(pickUser, keyInfo.fingerprint);
                        setKeyInfo({ ...keyInfo, state: 'trusted' });
                      }}
                    >
                      Trust this key
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="oc-field">
          <label>Permissions</label>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {ROLES.map((r: Role) => (
              <button
                key={r}
                className={`oc-btn oc-btn-sm${matchesRolePreset(selected, r) ? ' oc-btn-accent' : ''}`}
                onClick={() => setCaps(new Set(capabilitiesForRole(r)))}
              >
                {r}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {CAPABILITIES.map((c) => (
              <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={caps.has(c)}
                  disabled={c === 'read'}
                  onChange={() => toggleCap(c)}
                />
                {CAP_LABEL[c]}
              </label>
            ))}
          </div>
        </div>

        <button
          className="oc-btn oc-btn-accent"
          disabled={!pickUser || busy || !allNodes || keyInfo?.state === 'changed'}
          onClick={() => void grant()}
        >
          {busy ? 'Working…' : allNodes ? 'Grant access' : 'Loading…'}
        </button>
      </div>
    </Modal>
  );
}
