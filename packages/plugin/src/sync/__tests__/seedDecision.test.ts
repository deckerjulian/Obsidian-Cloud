import { describe, expect, it } from 'vitest';
import { decideSeedAction } from '../seedDecision';

const base = { readOnly: false };

describe('decideSeedAction', () => {
  it('does nothing when file and server already match', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: 'x', fileText: 'same', serverText: 'same' }),
    ).toBe('none');
  });

  it('pushes a brand-new local note (nothing on the server yet)', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: '', fileText: 'hello', serverText: '' }),
    ).toBe('push');
  });

  it('pulls into a freshly materialized empty file', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: '', fileText: '', serverText: 'server' }),
    ).toBe('pull');
  });

  it('pulls when only the server changed since the last sync', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: 'old', fileText: 'old', serverText: 'new' }),
    ).toBe('pull');
  });

  it('pushes when only the file changed since the last sync (offline edits)', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: 'old', fileText: 'edited', serverText: 'old' }),
    ).toBe('push');
  });

  it('conflicts when both sides changed differently', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: 'old', fileText: 'mine', serverText: 'theirs' }),
    ).toBe('conflict');
  });

  it('conflicts when a same-named vault file meets existing server content (fresh device)', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: '', fileText: 'local copy', serverText: 'server copy' }),
    ).toBe('conflict');
  });

  it('never lets an empty local file silently wipe server content', () => {
    // File was deleted/recreated empty while the plugin was off; the CRDT
    // still holds the old text. Must pull, not push the deletion.
    expect(
      decideSeedAction({ ...base, preSyncText: 'old', fileText: '', serverText: 'old' }),
    ).toBe('pull');
  });

  it('always pulls for read-only viewers', () => {
    expect(
      decideSeedAction({ readOnly: true, preSyncText: 'old', fileText: 'mine', serverText: 'theirs' }),
    ).toBe('pull');
  });

  it('treats identical independent edits as converged', () => {
    expect(
      decideSeedAction({ ...base, preSyncText: 'old', fileText: 'same', serverText: 'same' }),
    ).toBe('none');
  });
});
