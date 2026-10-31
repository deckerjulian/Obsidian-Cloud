import { hasCapability, type TreeNodeDto } from '@oc/shared';
import type ObsidianCloudPlugin from '../main';
import { Modal } from 'obsidian';
import { t } from '../i18n';
import { button, errorBox, icon, modalHeader } from '../ui/components';
import { selectVaultScope } from './vaultScope';

export type VaultChoice =
  | { kind: 'vault'; id: string; name: string }
  | { kind: 'legacy' };

interface ServerVault {
  id: string;
  name: string;
}

/** The vaults visible to the user, with decrypted names (undecryptable ones —
 *  not shared with us yet — are skipped: they can't be mirrored anyway). */
async function listServerVaults(plugin: ObsidianCloudPlugin, nodes: TreeNodeDto[]): Promise<ServerVault[]> {
  const out: ServerVault[] = [];
  for (const n of nodes) {
    if (!n.isVault) continue;
    const name = await plugin.e2ee.tryDecryptName(n.docId, n.name);
    if (name) out.push({ id: n.id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create a new server vault (top-level isVault folder) named `name`, keyed
 *  for this user and everyone entitled to it (admins). */
async function createServerVault(plugin: ObsidianCloudPlugin, name: string): Promise<ServerVault> {
  const { encryptedName, contentKey } = await plugin.e2ee.prepareName(name);
  const created = await plugin.syncEngine.tree.createNode({
    parentId: null,
    kind: 'folder',
    name: encryptedName,
    isVault: true,
  });
  if (created.docId) {
    try {
      await plugin.e2ee.storeContentKey(created.docId, contentKey);
    } catch (err) {
      // An unkeyed vault would be a nameless node for everyone — roll back.
      await plugin.syncEngine.tree.deleteNode(created.id).catch(() => undefined);
      throw err;
    }
    await plugin.e2ee.keyForGrantees(created.docId, contentKey).catch(() => undefined);
  }
  return { id: created.id, name };
}

/**
 * Ask which server vault this local vault mirrors. Offers every visible vault
 * (the one named like the local vault first and preselected), creating a new
 * vault from this local vault, and — when the server still has content outside
 * any vault — the legacy shared root. Resolves null when dismissed.
 */
export async function chooseVault(plugin: ObsidianCloudPlugin): Promise<VaultChoice | null> {
  const nodes = (await plugin.syncEngine.tree.getTree()).nodes;
  const vaults = await listServerVaults(plugin, nodes);
  const localName = plugin.app.vault.getName();
  // Content outside any vault (pre-vault servers) can still be mirrored as is.
  const legacy = selectVaultScope(nodes, null).nodes.some((n) => n.path !== '') || plugin.settings.legacyRoot;
  const picked = await new Promise<PickerResult | null>((resolve) =>
    new VaultPickerModal(plugin, vaults, localName, legacy, resolve).open(),
  );
  if (!picked) return null;
  if (picked.kind === 'legacy') return { kind: 'legacy' };
  if (picked.kind === 'create') {
    const v = await createServerVault(plugin, picked.name);
    return { kind: 'vault', ...v };
  }
  const v = vaults.find((x) => x.id === picked.id);
  return v ? { kind: 'vault', ...v } : null;
}

type PickerResult = { kind: 'vault'; id: string } | { kind: 'create'; name: string } | { kind: 'legacy' };

class VaultPickerModal extends Modal {
  private result: PickerResult | null = null;

  constructor(
    private readonly plugin: ObsidianCloudPlugin,
    private readonly vaults: ServerVault[],
    private readonly localName: string,
    private readonly legacy: boolean,
    private readonly resolve: (r: PickerResult | null) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    modalHeader(this, 'folder-sync|folder', t('picker.title'));
    const { contentEl } = this;
    contentEl.createEl('p', { cls: 'oc-lead', text: t('picker.intro', { local: this.localName }) });

    const match = this.vaults.find((v) => v.name === this.localName);
    const current = this.plugin.settings.vaultId;
    const ordered = match ? [match, ...this.vaults.filter((v) => v !== match)] : this.vaults;
    let selected: PickerResult | null = current && this.vaults.some((v) => v.id === current)
      ? { kind: 'vault', id: current }
      : match
        ? { kind: 'vault', id: match.id }
        : this.plugin.settings.legacyRoot
          ? { kind: 'legacy' }
          : { kind: 'create', name: this.localName };

    const list = contentEl.createDiv({ cls: 'oc-choices' });
    const rows: Array<{ el: HTMLElement; key: string }> = [];
    const keyOf = (r: PickerResult | null): string =>
      !r ? '' : r.kind === 'vault' ? `v:${r.id}` : r.kind;
    const select = (r: PickerResult): void => {
      selected = r;
      for (const row of rows) row.el.toggleClass('is-selected', row.key === keyOf(r));
      connect.disabled = false;
      error.set(null);
    };
    const addRow = (key: string, iconName: string, title: string, desc: string | null, onPick: () => PickerResult, badge?: string): HTMLElement => {
      const el = list.createDiv({ cls: 'oc-choice', attr: { tabindex: '0', role: 'radio' } });
      icon(el, iconName, 'oc-choice-icon');
      const body = el.createDiv({ cls: 'oc-choice-body' });
      const titleEl = body.createDiv({ cls: 'oc-choice-title', text: title });
      if (badge) titleEl.createSpan({ cls: 'oc-badge oc-tone-ok', text: badge });
      if (desc) body.createDiv({ cls: 'oc-choice-desc', text: desc });
      el.addEventListener('click', () => select(onPick()));
      el.addEventListener('dblclick', () => {
        select(onPick());
        void finish();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(onPick());
        }
      });
      rows.push({ el, key });
      return body;
    };

    for (const v of ordered) {
      addRow(`v:${v.id}`, 'vault|archive', v.name, null, () => ({ kind: 'vault', id: v.id }), v === match ? t('picker.sameName') : undefined);
    }
    if (this.vaults.length === 0) list.createDiv({ cls: 'oc-note', text: t('picker.noVaults') });
    let nameInput: HTMLInputElement | null = null;
    if (!match || this.vaults.length === 0) {
      const body = addRow('create', 'folder-plus|plus', t('picker.create'), t('picker.create.desc'), () => ({
        kind: 'create',
        name: nameInput?.value.trim() || this.localName,
      }));
      nameInput = body.createEl('input', { attr: { type: 'text', 'aria-label': t('picker.create.name') } });
      nameInput.value = this.localName;
      nameInput.addEventListener('focus', () => select({ kind: 'create', name: nameInput!.value.trim() }));
      nameInput.addEventListener('input', () => select({ kind: 'create', name: nameInput!.value.trim() }));
    }
    if (this.legacy) addRow('legacy', 'database', t('vault.legacy'), t('picker.legacy.desc'), () => ({ kind: 'legacy' }));

    const note = contentEl.createDiv({ cls: 'oc-callout oc-tone-ok' });
    note.style.marginTop = '14px';
    icon(note, 'shield-check|shield');
    note.createSpan({ text: t('picker.note') });
    const error = errorBox(contentEl);

    const buttons = contentEl.createDiv({ cls: 'oc-buttons' });
    button(buttons, t('action.cancel'), { onClick: () => this.close() });
    const connect = button(buttons, t('picker.connect'), { cta: true, onClick: () => void finish() });

    const finish = async (): Promise<void> => {
      if (!selected) return;
      if (selected.kind === 'create') {
        const name = nameInput?.value.trim() || this.localName;
        if (this.vaults.some((v) => v.name === name)) {
          error.set(t('picker.nameTaken'));
          return;
        }
        selected = { kind: 'create', name };
      }
      this.result = selected;
      this.close();
    };
    if (selected) select(selected);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.result);
  }
}

/** Whether the user may write into the vault's subtree (config push gate). */
export function canWriteVault(nodes: TreeNodeDto[], vaultId: string): boolean {
  const vault = nodes.find((n) => n.id === vaultId);
  return !!vault && (hasCapability(vault.capabilities, 'edit') || hasCapability(vault.capabilities, 'create'));
}
