import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, UserDto } from '@oc/shared';
import { apiFetch, ApiError, fetchTreeCached, type CachedTree } from '../api/http';

const REFRESH_KEY = 'oc.refreshToken';

export interface AuthFetchOptions {
  method?: string;
  body?: unknown;
}

interface AuthContextValue {
  user: UserDto | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  authFetch: <T>(path: string, opts?: AuthFetchOptions) => Promise<T>;
  /** Conditional GET /tree (ETag/304) for cheap background polling of the tree. */
  treeFetch: (etag: string | null, signal?: AbortSignal) => Promise<CachedTree>;
  /** Current in-memory access token (for the realtime WebSocket provider). */
  getAccessToken: () => string | null;
  /** Like getAccessToken, but refreshes first when the token is (nearly)
   *  expired — for WebSocket reconnects, which have no 401-retry path. */
  getFreshAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Unix seconds at which a JWT expires, or null if it can't be decoded. */
function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1])) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const accessToken = useRef<string | null>(null);
  const refreshing = useRef<Promise<boolean> | null>(null);

  const applyAuth = useCallback((res: AuthResponse) => {
    accessToken.current = res.tokens.accessToken;
    localStorage.setItem(REFRESH_KEY, res.tokens.refreshToken);
    setUser(res.user);
  }, []);

  const clearAuth = useCallback(() => {
    accessToken.current = null;
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
  }, []);

  const doRefresh = useCallback(async (): Promise<boolean> => {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (!refreshToken) return false;
    try {
      const res = await apiFetch<AuthResponse>('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });
      applyAuth(res);
      return true;
    } catch (err) {
      // Only a rejected token ends the session; a network failure must not
      // log the user out.
      if (err instanceof ApiError) clearAuth();
      return false;
    }
  }, [applyAuth, clearAuth]);

  /**
   * Single-flight: concurrent 401s (e.g. bootstrap + document-keys fired in
   * parallel with an expired token) must share ONE refresh request. The server
   * rotates refresh tokens and treats a replay as theft — it revokes the whole
   * token family, so a second parallel refresh would hard-log-out the user.
   */
  const refresh = useCallback((): Promise<boolean> => {
    refreshing.current ??= doRefresh().finally(() => {
      refreshing.current = null;
    });
    return refreshing.current;
  }, [doRefresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await apiFetch<AuthResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      applyAuth(res);
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (refreshToken) {
      try {
        await apiFetch('/auth/logout', { method: 'POST', body: { refreshToken } });
      } catch {
        /* best-effort */
      }
    }
    clearAuth();
  }, [clearAuth]);

  const authFetch = useCallback(
    async <T,>(path: string, opts: AuthFetchOptions = {}): Promise<T> => {
      try {
        return await apiFetch<T>(path, { ...opts, token: accessToken.current });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && (await refresh())) {
          return await apiFetch<T>(path, { ...opts, token: accessToken.current });
        }
        throw err;
      }
    },
    [refresh],
  );

  const treeFetch = useCallback(
    async (etag: string | null, signal?: AbortSignal): Promise<CachedTree> => {
      try {
        return await fetchTreeCached(accessToken.current, etag, signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && (await refresh())) {
          return await fetchTreeCached(accessToken.current, etag, signal);
        }
        throw err;
      }
    },
    [refresh],
  );

  const getAccessToken = useCallback(() => accessToken.current, []);

  const getFreshAccessToken = useCallback(async (): Promise<string | null> => {
    const token = accessToken.current;
    // 30 s of slack: a token that expires mid-handshake is as bad as expired.
    const exp = token ? jwtExpiry(token) : null;
    if (!token || (exp !== null && exp * 1000 - Date.now() < 30_000)) {
      await refresh();
    }
    return accessToken.current;
  }, [refresh]);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, login, logout, authFetch, treeFetch, getAccessToken, getFreshAccessToken }),
    [user, loading, login, logout, authFetch, treeFetch, getAccessToken, getFreshAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
