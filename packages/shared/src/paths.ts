/**
 * Vault path helpers. Paths are POSIX-style, '/'-separated, with NO leading or
 * trailing slash. The vault root is the empty string `''`.
 *
 * These must match between the Obsidian client, the server and the web app so
 * that `path` columns and ACL ancestor lookups line up exactly.
 */

/** Normalize a raw path: backslashes → '/', collapse '//', strip edge slashes. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim();
}

/** Split into segments. Root `''` → `[]`. */
export function splitPath(path: string): string[] {
  const p = normalizePath(path);
  return p === '' ? [] : p.split('/');
}

/** The final segment (file/folder name). Root → `''`. */
export function basename(path: string): string {
  const segs = splitPath(path);
  return segs.length ? segs[segs.length - 1] : '';
}

/** The parent path. `'a/b/c'` → `'a/b'`; top-level `'a'` → `''` (root). */
export function parentPath(path: string): string {
  const segs = splitPath(path);
  segs.pop();
  return segs.join('/');
}

/** Whether a file name denotes an editable text note. Obsidian recognises .md;
 *  everything else is treated as a binary attachment (stored as an encrypted blob). */
export function isTextFileName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** Join a parent path and a child name. */
export function joinPath(parent: string, name: string): string {
  const p = normalizePath(parent);
  const n = normalizePath(name);
  return p === '' ? n : `${p}/${n}`;
}

/** Number of segments. Root `''` → 0, `'a'` → 1, `'a/b'` → 2. */
export function depthOf(path: string): number {
  return splitPath(path).length;
}

/**
 * All ancestor paths from the root down to and including `path` itself.
 * `'a/b/c'` → `['', 'a', 'a/b', 'a/b/c']`. Used by the ACL resolver to find the
 * nearest explicit grant via a single `path IN (...)` query.
 */
export function ancestorPaths(path: string): string[] {
  const segs = splitPath(path);
  const out: string[] = [''];
  let acc = '';
  for (const seg of segs) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    out.push(acc);
  }
  return out;
}

/** True when `ancestor` is `path` itself or a folder above it. */
export function isAncestorOrSelf(ancestor: string, path: string): boolean {
  const a = normalizePath(ancestor);
  const p = normalizePath(path);
  return a === '' || a === p || p.startsWith(`${a}/`);
}
