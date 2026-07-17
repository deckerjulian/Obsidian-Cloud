import type { TFile, Vault } from 'obsidian';
import * as Y from 'yjs';
import { YTEXT_FIELD } from '@oc/shared';
import { computeTextDiff } from './textDiff';
import { decideSeedAction } from './seedDecision';

/** Sentinel origin tagging Y.Text mutations that came FROM the local file, so
 *  the observer doesn't echo them back to disk. */
const BRIDGE_ORIGIN = Symbol('oc-vault-bridge');

/** A file that diverged both locally and on the server. */
export interface ContentConflict {
  path: string;
  localText: string;
  serverText: string;
}

/** How the user chose to resolve a content conflict ('later' = dismissed). */
export type ConflictChoice = 'server' | 'local' | 'both' | 'later';

/** Apply a minimal single-range diff to `ytext` so unchanged regions keep their
 *  CRDT identity. */
function applyMinimalDiff(ytext: Y.Text, oldStr: string, newStr: string): void {
  const { pos, delCount, insStr } = computeTextDiff(oldStr, newStr);
  if (delCount > 0) ytext.delete(pos, delCount);
  if (insStr.length > 0) ytext.insert(pos, insStr);
}

/**
 * Two-way bridge between a Yjs document's text and an Obsidian vault file.
 *
 * `start()` runs only once the document is synced with the server (and local
 * persistence is loaded); it decides the initial direction via a 3-way
 * comparison and may ask the user to resolve a conflict before the two-way
 * bridge activates.
 *
 * Loop prevention rests on two invariants:
 *  - file→Y.Text edits are applied inside a transaction tagged BRIDGE_ORIGIN,
 *    which the Y.Text observer ignores; and
 *  - Y.Text→file writes leave file == Y.Text, so the resulting 'modify' event
 *    produces an empty diff and stops.
 *
 * For viewers (read-only) the bridge runs one-way (server → file only); local
 * modifications are reverted back to the server state.
 */
export class VaultBridge {
  private readonly ytext: Y.Text;
  private observer?: (event: Y.YTextEvent, tr: Y.Transaction) => void;
  private toFileTimer: ReturnType<typeof setTimeout> | null = null;
  private toYTextTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private active = false;

  constructor(
    private readonly vault: Vault,
    private file: TFile,
    private readonly ydoc: Y.Doc,
    private readonly isReadOnly: () => boolean,
    private readonly resolveConflict: (conflict: ContentConflict) => Promise<ConflictChoice>,
  ) {
    this.ytext = ydoc.getText(YTEXT_FIELD);
  }

  /**
   * Seed (3-way) and activate the bridge. `preSyncText` is the Y.Text content
   * before any server updates arrived — the merge base. Returns false when the
   * user deferred a conflict; the bridge then stays inactive so nothing is
   * overwritten and reopening the file asks again.
   */
  async start(preSyncText: string): Promise<boolean> {
    const fileText = await this.vault.read(this.file);
    const serverText = this.ytext.toString();
    const action = decideSeedAction({
      preSyncText,
      fileText,
      serverText,
      readOnly: this.isReadOnly(),
    });

    // Which side wins a race while we were seeding (e.g. edits typed while the
    // conflict modal was open, or remote updates arriving mid-decision).
    let favorLocal = action === 'push' || action === 'none';

    if (action === 'conflict') {
      const choice = await this.resolveConflict({ path: this.file.path, localText: fileText, serverText });
      if (this.disposed || choice === 'later') return false;
      // Re-read: the file may have changed while the modal was open. For
      // 'local'/'both' those edits are preserved (we push/copy `latest`); for
      // 'server' the user explicitly chose to discard the local side.
      const latest = await this.vault.read(this.file);
      if (choice === 'server') {
        await this.writeFile(this.ytext.toString());
      } else if (choice === 'local') {
        this.pushToDoc(latest);
        favorLocal = true;
      } else {
        // Keep both: the local version becomes a sibling conflict copy (its
        // vault 'create' event pushes it to the server as a new note), and the
        // original file takes the server version.
        await this.vault.create(this.conflictCopyPath(), latest);
        await this.writeFile(this.ytext.toString());
      }
    } else if (action === 'pull') {
      await this.writeFile(this.ytext.toString());
    } else if (action === 'push') {
      this.pushToDoc(fileText);
    }

    if (this.disposed) return false;
    this.observer = (_event, tr) => {
      if (tr.origin === BRIDGE_ORIGIN) return; // our own file→Y.Text edit
      this.scheduleToFile();
    };
    this.ytext.observe(this.observer);
    this.active = true;
    // Converge anything that changed while seeding, in the chosen direction.
    if (favorLocal && !this.isReadOnly()) this.scheduleToYText();
    else this.scheduleToFile();
    return true;
  }

  /** Called by the owner on a vault 'modify' event for this file. */
  onFileModified(file: TFile): void {
    if (this.disposed || file.path !== this.file.path) return;
    this.file = file;
    if (!this.active) return; // not seeded yet
    if (this.isReadOnly()) {
      // Viewer access: a local change (external editor, another plugin) is
      // reverted to the server state instead of silently diverging. writeFile
      // no-ops once file == Y.Text, so this cannot loop.
      this.scheduleToFile();
      return;
    }
    this.scheduleToYText();
  }

  private pushToDoc(fileText: string): void {
    this.ydoc.transact(
      () => applyMinimalDiff(this.ytext, this.ytext.toString(), fileText),
      BRIDGE_ORIGIN,
    );
  }

  private async writeFile(text: string): Promise<void> {
    const current = await this.vault.read(this.file);
    if (current !== text) await this.vault.modify(this.file, text);
  }

  /** "Note.md" → "Note (conflict 2026-07-03 1412).md", avoiding collisions. */
  private conflictCopyPath(): string {
    const p = this.file.path;
    const dot = p.lastIndexOf('.');
    const hasExt = dot > p.lastIndexOf('/');
    const stem = hasExt ? p.slice(0, dot) : p;
    const ext = hasExt ? p.slice(dot) : '';
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const tag = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    let candidate = `${stem} (conflict ${tag})${ext}`;
    for (let i = 2; this.vault.getAbstractFileByPath(candidate); i++) {
      candidate = `${stem} (conflict ${tag} ${i})${ext}`;
    }
    return candidate;
  }

  private scheduleToFile(): void {
    if (this.toFileTimer) clearTimeout(this.toFileTimer);
    this.toFileTimer = setTimeout(() => void this.flushToFile(), 150);
  }

  private scheduleToYText(): void {
    if (this.toYTextTimer) clearTimeout(this.toYTextTimer);
    this.toYTextTimer = setTimeout(() => void this.flushToYText(), 300);
  }

  private async flushToFile(): Promise<void> {
    if (this.disposed) return;
    // A pending local flush means the file holds edits not yet in Y.Text
    // (remote flushes fire after 150 ms, local ones after 300 ms). Fold them
    // into the doc FIRST — writing the doc out now would silently erase them.
    if (this.toYTextTimer && !this.isReadOnly()) {
      clearTimeout(this.toYTextTimer);
      this.toYTextTimer = null;
      await this.flushToYText();
    }
    await this.writeFile(this.ytext.toString());
  }

  private async flushToYText(): Promise<void> {
    if (this.disposed || this.isReadOnly()) return;
    const fileContent = await this.vault.read(this.file);
    if (fileContent === this.ytext.toString()) return;
    this.pushToDoc(fileContent);
  }

  destroy(): void {
    this.disposed = true;
    if (this.toFileTimer) clearTimeout(this.toFileTimer);
    if (this.toYTextTimer) clearTimeout(this.toYTextTimer);
    if (this.observer) this.ytext.unobserve(this.observer);
  }
}
