import { describe, it, expect } from 'vitest';
import { mergeDeviceState, splitDeviceState } from '../deviceState';

describe('splitDeviceState', () => {
  it('separates device-only keys from shared settings', () => {
    const { shared, device } = splitDeviceState({
      serverUrl: 'https://x',
      vaultId: 'v1',
      refreshToken: 'rt',
      trackedPaths: ['a.md'],
      docIds: { 'a.md': 'd1' },
      initialSyncDone: true,
      ignoredPaths: ['tmp'],
    });
    expect(shared).toEqual({ serverUrl: 'https://x', vaultId: 'v1', ignoredPaths: ['tmp'] });
    expect(device).toEqual({
      refreshToken: 'rt',
      trackedPaths: ['a.md'],
      docIds: { 'a.md': 'd1' },
      initialSyncDone: true,
    });
  });
});

describe('mergeDeviceState', () => {
  it('migrates device keys out of data.json when this device has no state yet', () => {
    const { merged, migrated } = mergeDeviceState({ serverUrl: 'u', refreshToken: 'old' }, null);
    expect(migrated).toBe(true);
    expect(merged).toEqual({ serverUrl: 'u', refreshToken: 'old' });
  });

  it('prefers this device over leftovers in data.json (and asks to strip them)', () => {
    const { merged, migrated } = mergeDeviceState(
      { serverUrl: 'u', refreshToken: 'other-device', trackedPaths: ['x.md'] },
      { refreshToken: 'mine' },
    );
    expect(migrated).toBe(true);
    expect(merged).toEqual({ serverUrl: 'u', refreshToken: 'mine' });
  });

  it('needs no save when data.json is already clean', () => {
    expect(mergeDeviceState({ serverUrl: 'u' }, { refreshToken: 'r' }).migrated).toBe(false);
    expect(mergeDeviceState(null, null)).toEqual({ merged: {}, migrated: false });
  });
});
