export type SyncLogLevel = 'info' | 'success' | 'error';

export interface SyncLogEntry {
  time: number;
  level: SyncLogLevel;
  message: string;
}

/** A small in-memory ring buffer of sync events, observable by the settings UI. */
export class SyncLog {
  private entries: SyncLogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly max = 300;

  add(level: SyncLogLevel, message: string): void {
    this.entries.push({ time: Date.now(), level, message });
    if (this.entries.length > this.max) {
      this.entries.splice(0, this.entries.length - this.max);
    }
    for (const l of this.listeners) l();
    // eslint-disable-next-line no-console
    console.log(`[Obsidian-Cloud] ${level}: ${message}`);
  }

  info(message: string): void {
    this.add('info', message);
  }
  success(message: string): void {
    this.add('success', message);
  }
  error(message: string): void {
    this.add('error', message);
  }

  all(): SyncLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Outcome of a structural reconciliation pass. */
export interface SyncReport {
  foldersCreated: number;
  filesCreated: number;
  /** Local-only files/folders uploaded to the server. */
  pushed: number;
  removed: number;
  errors: string[];
}

export function summarizeReport(r: SyncReport): string {
  const parts = [`${r.foldersCreated} folders`, `${r.filesCreated} notes`];
  if (r.pushed) parts.push(`${r.pushed} uploaded`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.errors.length) parts.push(`${r.errors.length} errors`);
  return parts.join(', ');
}
