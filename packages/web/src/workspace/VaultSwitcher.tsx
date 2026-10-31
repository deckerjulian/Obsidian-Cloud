import { useState } from 'react';
import { hasCapability } from '@oc/shared';
import { useVaults } from '../vault/VaultContext';
import { AclPanel } from '../acl/AclPanel';
import { ContextMenu, LIcon, type MenuItem } from './Sidebar';

/** Obsidian's vault switcher (bottom of the left sidebar) + account access. */
export function VaultSwitcher({
  onAccount,
  onAdmin,
  onLegacy,
  onError,
}: {
  onAccount: () => void;
  onAdmin?: () => void;
  onLegacy: () => void;
  onError: (msg: string) => void;
}) {
  const { vaults, currentVaultId, selectVault, createVault, renameVault, deleteVault, hasLegacyContent } = useVaults();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [share, setShare] = useState(false);
  const current = vaults.find((v) => v.id === currentVaultId);

  const items: MenuItem[] = [
    ...vaults.map((v) => ({
      label: `${v.id === currentVaultId ? '✓ ' : ''}${v.name}`,
      icon: 'vault',
      onClick: () => selectVault(v.id),
    })),
    {
      label: 'Neuen Vault erstellen…',
      icon: 'plus',
      onClick: () => {
        const name = window.prompt('Name des neuen Vaults');
        if (name?.trim()) createVault(name.trim()).catch((e) => onError((e as Error).message));
      },
    },
  ];
  if (current && hasCapability(current.node.capabilities, 'edit')) {
    items.push({
      label: 'Vault umbenennen…',
      icon: 'pencil',
      onClick: () => {
        const name = window.prompt('Neuer Name', current.name);
        if (name?.trim() && name !== current.name) renameVault(current.id, name.trim()).catch((e) => onError((e as Error).message));
      },
    });
  }
  if (current && hasCapability(current.node.capabilities, 'share')) {
    items.push({ label: 'Vault teilen…', icon: 'link', onClick: () => setShare(true) });
  }
  if (hasLegacyContent || onAdmin) items.push({ label: 'Server-Baum (ohne Vault)', icon: 'list-tree', onClick: onLegacy });
  if (onAdmin) items.push({ label: 'Benutzerverwaltung', icon: 'settings', onClick: onAdmin });
  if (current && hasCapability(current.node.capabilities, 'delete')) {
    items.push({
      label: 'Vault löschen…',
      icon: 'trash',
      danger: true,
      onClick: () => {
        const typed = window.prompt(
          `Vault „${current.name}“ mit ALLEN Notizen auf dem Server löschen? Zur Bestätigung den Namen eintippen:`,
        );
        if (typed === current.name) deleteVault(current.id).catch((e) => onError((e as Error).message));
      },
    });
  }

  return (
    <div className="workspace-sidedock-vault-profile">
      <div
        className="workspace-drawer-vault-switcher is-clickable"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu({ x: r.left, y: Math.max(8, r.top - 36 * items.length - 12) });
        }}
        title="Vault wechseln"
      >
        <LIcon name="vault" size={15} />
        <span className="workspace-drawer-vault-name">{current?.name ?? '—'}</span>
        <LIcon name="chevron-down" size={14} />
      </div>
      <button className="clickable-icon" title="Konto & Einstellungen" onClick={onAccount}>
        <LIcon name="settings" size={16} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {share && current && <AclPanel node={current.node} onClose={() => setShare(false)} />}
    </div>
  );
}

/** First run without any vault: create one (or look at the legacy tree). */
export function VaultOnboarding({
  onLegacy,
  onAccount,
  onError,
}: {
  onLegacy: () => void;
  onAccount: () => void;
  onError: (msg: string) => void;
}) {
  const { createVault, hasLegacyContent } = useVaults();
  const [name, setName] = useState('Mein Vault');
  const [busy, setBusy] = useState(false);
  return (
    <div className="oc-empty oc-onboarding">
      <LIcon name="vault" size={40} />
      <h2>Noch kein Vault</h2>
      <p className="oc-faint">
        Ein Vault entspricht einem Obsidian-Vault. Lege hier einen leeren an – oder verbinde in der Obsidian-App das
        Obsidian-Cloud-Plugin und wähle „Vault aus diesem lokalen Vault erstellen“.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="oc-input" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="oc-btn oc-btn-primary"
          disabled={busy || !name.trim()}
          onClick={() => {
            setBusy(true);
            createVault(name.trim())
              .catch((e) => onError((e as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          Vault erstellen
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {hasLegacyContent && (
          <button className="oc-btn" onClick={onLegacy}>
            Vorhandene Inhalte (ohne Vault) ansehen
          </button>
        )}
        <button className="oc-btn" onClick={onAccount}>
          Konto
        </button>
      </div>
    </div>
  );
}
