export type SeedAction = 'none' | 'pull' | 'push' | 'conflict';

export interface SeedInput {
  /** Y.Text content loaded from local persistence BEFORE server updates arrived
   *  (the last state this device saw — the 3-way merge base). */
  preSyncText: string;
  /** Current content of the vault file. */
  fileText: string;
  /** Y.Text content AFTER the server's stored updates were applied. */
  serverText: string;
  readOnly: boolean;
}

/**
 * Decide the initial sync direction when a document session opens, using the
 * locally persisted CRDT state as the 3-way base:
 *  - only the file changed since last sync   → push it to the server,
 *  - only the server changed                 → materialize it locally,
 *  - both changed differently                → conflict (ask the user).
 *
 * Safety rule: an EMPTY local file never wins silently — reconcile creates
 * empty placeholders for server notes, and pushing that emptiness would wipe
 * the note for everyone.
 */
export function decideSeedAction(input: SeedInput): SeedAction {
  const { preSyncText, fileText, serverText, readOnly } = input;

  if (fileText === serverText) return 'none';
  if (readOnly) return 'pull'; // viewers can never push
  if (fileText === '' && serverText !== '') return 'pull';

  const localChanged = fileText !== preSyncText;
  const remoteChanged = serverText !== preSyncText;
  if (!localChanged) return 'pull';
  if (!remoteChanged) return 'push';
  return 'conflict';
}
