/**
 * Obsidian's link resolution (`metadataCache.getFirstLinkpathDest`): a link
 * resolves by exact vault path first (with or without `.md`, also relative
 * to the source note's folder), then by file name — preferring a match in
 * the source's own folder, then the shortest path.
 */

export interface LinkTarget {
  path: string;
}

/** `"Note#Heading"` → `{ path: 'Note', subpath: '#Heading' }`. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.search(/[#^]/);
  if (i < 0) return { path: linktext, subpath: '' };
  return { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stripMd = (p: string): string => p.replace(/\.md$/i, '');

/** Collapse `.`/`..` segments. */
function normalizeRelative(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export class LinkResolver<T extends LinkTarget> {
  private byPath = new Map<string, T>();
  private byLowerPath = new Map<string, T>();
  /** lower-cased name (and name without .md) → files */
  private byName = new Map<string, T[]>();

  constructor(files: Iterable<T>) {
    for (const f of files) {
      this.byPath.set(f.path, f);
      this.byLowerPath.set(f.path.toLowerCase(), f);
      const n = nameOf(f.path).toLowerCase();
      const keys = new Set([n, stripMd(n)]);
      for (const k of keys) {
        const list = this.byName.get(k) ?? [];
        list.push(f);
        this.byName.set(k, list);
      }
    }
  }

  resolve(linkpathRaw: string, sourcePath: string): T | null {
    let linkpath = linkpathRaw.trim();
    try {
      linkpath = decodeURIComponent(linkpath);
    } catch {
      /* not URI-encoded */
    }
    if (linkpath === '') return this.byPath.get(sourcePath) ?? null;
    linkpath = linkpath.replace(/^\/+/, '');
    const exact = (p: string): T | null =>
      this.byPath.get(p) ??
      this.byPath.get(`${p}.md`) ??
      this.byLowerPath.get(p.toLowerCase()) ??
      this.byLowerPath.get(`${p}.md`.toLowerCase()) ??
      null;

    const direct = exact(normalizeRelative(linkpath));
    if (direct) return direct;
    const srcDir = dirOf(sourcePath);
    if (srcDir) {
      const rel = exact(normalizeRelative(`${srcDir}/${linkpath}`));
      if (rel) return rel;
    }

    const name = nameOf(linkpath).toLowerCase();
    let candidates = this.byName.get(name) ?? this.byName.get(stripMd(name)) ?? [];
    if (linkpath.includes('/')) {
      // A partial path ("Folder/Note") must match the end of the full path.
      const tail = `/${stripMd(linkpath.toLowerCase())}`;
      candidates = candidates.filter((c) => `/${stripMd(c.path.toLowerCase())}`.endsWith(tail));
    }
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const sameDir = candidates.find((c) => dirOf(c.path) === srcDir);
    if (sameDir) return sameDir;
    // Prefer Markdown notes for extension-less links, then the shortest path.
    const preferMd = !/\.[^/.]+$/.test(linkpath);
    return [...candidates].sort((a, b) => {
      if (preferMd) {
        const am = /\.md$/i.test(a.path) ? 0 : 1;
        const bm = /\.md$/i.test(b.path) ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      return a.path.length - b.path.length || a.path.localeCompare(b.path);
    })[0];
  }
}
