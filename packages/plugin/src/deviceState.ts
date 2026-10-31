/**
 * Per-device sync state, kept OUT of the plugin's data.json.
 *
 * data.json lives inside the vault's config folder, so iCloud / Obsidian Sync /
 * Syncthing copy it to every device that opens the vault. Two pieces of state
 * must never travel that way:
 *  - the refresh token: two devices presenting the same rotating refresh token
 *    trip the server's reuse detection, which revokes the whole session family
 *    and signs BOTH devices out;
 *  - the sync bookkeeping (trackedPaths, docIds, …): a device whose file sync
 *    hasn't downloaded a file yet would see it "tracked but missing locally"
 *    and propagate that as a deletion to the server — and from there to every
 *    other device.
 * These keys are stored in the vault-scoped localStorage of this device instead.
 */
export const DEVICE_STATE_KEYS = [
  'refreshToken',
  'accountId',
  'trackedPaths',
  'docIds',
  'initialSyncDone',
  'adminKeySignature',
  'configPushed',
] as const;

export type DeviceStateKey = (typeof DEVICE_STATE_KEYS)[number];

/** localStorage key (Obsidian scopes it to the vault). */
export const DEVICE_STATE_STORAGE_KEY = 'obsidian-cloud:device-state';

type Bag = Record<string, unknown>;

/** Split a settings object into the shared (data.json) and device parts. */
export function splitDeviceState<T extends Bag>(settings: T): { shared: Bag; device: Bag } {
  const shared: Bag = {};
  const device: Bag = {};
  for (const [k, v] of Object.entries(settings)) {
    if ((DEVICE_STATE_KEYS as readonly string[]).includes(k)) device[k] = v;
    else shared[k] = v;
  }
  return { shared, device };
}

/**
 * Combine what was loaded from data.json and from this device's storage.
 *
 * Migration: when this device has no stored state yet but data.json still
 * carries device keys (written by an older plugin version), they are adopted
 * once — `migrated` tells the caller to persist both sides, which strips them
 * from data.json. Once device state exists, device keys found in data.json are
 * ignored (another device's leftovers) and dropped on the next save.
 */
export function mergeDeviceState(
  data: Bag | null | undefined,
  device: Bag | null | undefined,
): { merged: Bag; migrated: boolean } {
  const fromData = data ?? {};
  const { shared, device: legacyDevice } = splitDeviceState(fromData);
  if (device) return { merged: { ...shared, ...device }, migrated: Object.keys(legacyDevice).length > 0 };
  const hasLegacy = Object.keys(legacyDevice).length > 0;
  return { merged: { ...shared, ...legacyDevice }, migrated: hasLegacy };
}
