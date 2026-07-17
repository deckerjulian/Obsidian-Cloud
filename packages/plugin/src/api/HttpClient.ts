import { requestUrl } from 'obsidian';
import { API_BASE } from '@oc/shared';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClientOptions {
  getBaseUrl: () => string;
  getAccessToken: () => string | null;
  /** Attempt to refresh the access token. Returns true on success. */
  refresh: () => Promise<boolean>;
  onUnauthorized: () => void;
}

export interface HttpMeta<T> {
  status: number;
  /** Parsed body; undefined for 204/304. */
  json: T | undefined;
  /** Response headers (keys lowercased). */
  headers: Record<string, string>;
}

/**
 * Thin REST client built on Obsidian's `requestUrl` (CORS-free, works on
 * desktop and mobile). Transparently refreshes the access token once on 401.
 */
export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  async request<T>(method: string, path: string, body?: unknown, allowRetry = true): Promise<T> {
    const res = await this.requestWithMeta<T>(method, path, { body, allowRetry });
    return res.json as T;
  }

  /** Like request(), but exposes status + headers (for ETag/304 handling). */
  async requestWithMeta<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; allowRetry?: boolean } = {},
  ): Promise<HttpMeta<T>> {
    const { body, allowRetry = true } = opts;
    const token = this.opts.getAccessToken();
    const headers: Record<string, string> = { ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await requestUrl({
      url: `${this.opts.getBaseUrl()}${API_BASE}${path}`,
      method,
      contentType: 'application/json',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      throw: false,
    });

    // Also refresh when no access token was attached yet (e.g. offline start:
    // a refresh token exists but the in-memory access token was never issued).
    if (res.status === 401 && allowRetry) {
      const refreshed = await this.opts.refresh();
      if (refreshed) return this.requestWithMeta<T>(method, path, { ...opts, allowRetry: false });
      if (token) this.opts.onUnauthorized();
    }

    if (res.status >= 400) {
      throw new HttpError(res.status, this.extractMessage(res, method, path));
    }

    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) responseHeaders[k.toLowerCase()] = v;

    if (res.status === 204 || res.status === 304) {
      return { status: res.status, json: undefined, headers: responseHeaders };
    }
    return { status: res.status, json: res.json as T, headers: responseHeaders };
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  private extractMessage(res: { status: number; json?: unknown }, method: string, path: string): string {
    try {
      const data = res.json as { message?: string } | undefined;
      if (data?.message) return data.message;
    } catch {
      /* non-JSON error body */
    }
    return `HTTP ${res.status} on ${method} ${path}`;
  }
}
