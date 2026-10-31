import { relativeTime, t } from '../i18n';

export type SyncStatus = 'offline' | 'online' | 'syncing' | 'error';
export type E2eeState = 'unknown' | 'not-setup' | 'locked' | 'unlocked';

/** Everything the status UI (status bar, menu, settings) is derived from. */
export interface StatusInput {
  signedIn: boolean;
  e2ee: E2eeState;
  /** Display name of the chosen server vault, or null. */
  vaultName: string | null;
  initialSyncDone: boolean;
  sync: SyncStatus;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export type Tone = 'off' | 'warn' | 'busy' | 'ok' | 'error';
/** What the primary button should do. */
export type NextAction = 'signIn' | 'setUpEncryption' | 'unlock' | 'chooseVault' | 'startSync' | 'retry' | null;

export interface StatusView {
  tone: Tone;
  /** Lucide icon name. */
  icon: string;
  title: string;
  /** Status-bar label. */
  short: string;
  detail: string;
  action: NextAction;
}

/**
 * The single answer to "what is going on, and what should I do next?" — the
 * first unmet setup step wins, then the live sync state.
 */
export function describeStatus(s: StatusInput, now = Date.now()): StatusView {
  if (!s.signedIn) {
    return { tone: 'off', icon: 'cloud-off', title: t('status.signedOut'), short: t('status.short.signedOut'), detail: t('status.signedOut.detail'), action: 'signIn' };
  }
  if (s.e2ee === 'not-setup') {
    return { tone: 'warn', icon: 'key-round|key', title: t('status.encSetup'), short: t('status.short.setup'), detail: t('status.encSetup.detail'), action: 'setUpEncryption' };
  }
  if (s.e2ee === 'locked') {
    return { tone: 'warn', icon: 'lock', title: t('status.locked'), short: t('status.short.locked'), detail: t('status.locked.detail'), action: 'unlock' };
  }
  if (!s.vaultName) {
    return { tone: 'warn', icon: 'folder-sync|folder', title: t('status.noVault'), short: t('status.short.noVault'), detail: t('status.noVault.detail'), action: 'chooseVault' };
  }
  if (s.sync === 'syncing') {
    return { tone: 'busy', icon: 'refresh-cw', title: t('status.syncing'), short: t('status.short.syncing'), detail: t('status.syncing.detail', { vault: s.vaultName }), action: null };
  }
  if (!s.initialSyncDone && s.sync !== 'error' && s.sync !== 'offline') {
    return { tone: 'warn', icon: 'cloud-upload|upload-cloud|upload', title: t('status.firstSync'), short: t('status.short.setup'), detail: t('status.firstSync.detail'), action: 'startSync' };
  }
  if (s.sync === 'offline') {
    return { tone: 'error', icon: 'cloud-off', title: t('status.offline'), short: t('status.short.offline'), detail: t('status.offline.detail'), action: 'retry' };
  }
  if (s.sync === 'error') {
    return { tone: 'error', icon: 'triangle-alert|alert-triangle', title: t('status.error'), short: t('status.short.error'), detail: s.lastError ?? '', action: 'retry' };
  }
  const when = s.lastSyncedAt ? relativeTime(s.lastSyncedAt, now) : null;
  return {
    tone: 'ok',
    icon: 'cloud',
    title: t('status.ok'),
    short: when ?? t('status.ok'),
    detail: when ? t('status.ok.detail', { vault: s.vaultName, when }) : t('status.ok.never', { vault: s.vaultName }),
    action: null,
  };
}

/** The setup checklist shown until everything is in place. */
export interface SetupStep {
  label: string;
  state: 'done' | 'current' | 'todo';
}

export function setupSteps(s: StatusInput, serverOk: boolean): SetupStep[] {
  const done = [
    serverOk || s.signedIn,
    s.signedIn,
    s.signedIn && s.e2ee === 'unlocked',
    s.signedIn && !!s.vaultName,
    s.signedIn && s.initialSyncDone,
  ];
  const labels = [t('settings.step.server'), t('settings.step.account'), t('settings.step.encryption'), t('settings.step.vault'), t('settings.step.sync')];
  const first = done.indexOf(false);
  return labels.map((label, i) => ({ label, state: done[i] ? 'done' : i === first ? 'current' : 'todo' }));
}
