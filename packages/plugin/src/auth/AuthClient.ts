import type { AuthResponse, UserDto } from '@oc/shared';
import { HttpError, type HttpClient } from '../api/HttpClient';
import type { TokenStore } from './TokenStore';

/** Authentication against the backend; stores the resulting tokens. */
export class AuthClient {
  private refreshing: Promise<boolean> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly store: TokenStore,
  ) {}

  hasSession(): boolean {
    return this.store.getRefreshToken() !== null;
  }

  async login(username: string, password: string, provider?: string): Promise<UserDto> {
    const res = await this.http.request<AuthResponse>(
      'POST',
      '/auth/login',
      { username, password, provider: provider || undefined },
      false,
    );
    this.store.setTokens(res.tokens, res.user.email, res.user.id);
    await this.store.persist();
    return res.user;
  }

  /**
   * Exchange the stored refresh token for a fresh token pair. Single-flight:
   * concurrent callers share one request — a second parallel refresh would
   * present the already-rotated token and trip the server's reuse detection,
   * revoking the whole token family (spurious logout).
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const refreshToken = this.store.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await this.http.request<AuthResponse>(
        'POST',
        '/auth/refresh',
        { refreshToken },
        false,
      );
      this.store.setTokens(res.tokens, res.user.email, res.user.id);
      await this.store.persist();
      return true;
    } catch (err) {
      // Only a definitive rejection ends the session. Network failures and
      // rate limiting (offline start, server restart, 429) must NOT wipe the
      // refresh token.
      const status = err instanceof HttpError ? err.status : 0;
      if (status === 400 || status === 401 || status === 403) {
        this.store.clear();
        await this.store.persist();
      }
      return false;
    }
  }

  async logout(): Promise<void> {
    const refreshToken = this.store.getRefreshToken();
    if (refreshToken) {
      try {
        await this.http.request('POST', '/auth/logout', { refreshToken }, false);
      } catch {
        /* best-effort */
      }
    }
    this.store.clear();
    await this.store.persist();
  }
}
