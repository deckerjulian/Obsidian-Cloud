import type { TokenPair } from '@oc/shared';
import type ObsidianCloudPlugin from '../main';

/**
 * Holds the short-lived access token in memory and persists ONLY the refresh
 * token — in this device's vault-scoped storage, not in the (synced) data.json,
 * see deviceState.ts (there is no OS keychain on mobile). Mitigations: short
 * access TTL, refresh rotation + reuse detection server-side, and logout revoke.
 */
export class TokenStore {
  private accessToken: string | null = null;
  private accessExpiry = 0;

  constructor(private readonly plugin: ObsidianCloudPlugin) {}

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getRefreshToken(): string | null {
    return this.plugin.settings.refreshToken;
  }

  isAccessTokenValid(): boolean {
    return this.accessToken !== null && Date.now() < this.accessExpiry - 5_000;
  }

  setTokens(tokens: TokenPair, accountEmail?: string, accountId?: string): void {
    this.accessToken = tokens.accessToken;
    this.accessExpiry = Date.now() + tokens.expiresIn * 1000;
    this.plugin.settings.refreshToken = tokens.refreshToken;
    if (accountEmail) this.plugin.settings.accountEmail = accountEmail;
    if (accountId) this.plugin.settings.accountId = accountId;
  }

  clear(): void {
    this.accessToken = null;
    this.accessExpiry = 0;
    this.plugin.settings.refreshToken = null;
    this.plugin.settings.accountEmail = null;
    this.plugin.settings.accountId = null;
  }

  persist(): Promise<void> {
    return this.plugin.saveSettings();
  }
}
