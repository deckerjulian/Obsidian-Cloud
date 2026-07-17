import { API_BASE, type TreeResponse } from '@oc/shared';

/** Base URL for the API. Empty string = same origin (behind the reverse proxy). */
const API_ORIGIN = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const res = await fetch(`${API_ORIGIN}${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
    credentials: 'include',
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { message?: string };
      if (data?.message) message = data.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CachedTree {
  /** True when the server returned 304 — the tree is unchanged since `etag`. */
  notModified: boolean;
  tree: TreeResponse | null;
  /** The current server ETag, to pass back on the next poll. */
  etag: string | null;
}

/**
 * Fetch GET /tree with conditional-request support so background polls stay
 * cheap: a 304 (unchanged) returns no body. `cache: 'no-store'` keeps the
 * browser HTTP cache out of the way so our If-None-Match round-trips to the
 * server and a real 304 surfaces here.
 */
export async function fetchTreeCached(
  token: string | null,
  etag: string | null,
  signal?: AbortSignal,
): Promise<CachedTree> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(`${API_ORIGIN}${API_BASE}/tree`, {
    method: 'GET',
    headers,
    credentials: 'include',
    cache: 'no-store',
    signal,
  });

  if (res.status === 304) return { notModified: true, tree: null, etag };
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { message?: string };
      if (data?.message) message = data.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  const tree = (await res.json()) as TreeResponse;
  return { notModified: false, tree, etag: res.headers.get('ETag') };
}
