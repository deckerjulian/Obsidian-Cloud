import type { AuthSource } from '@oc/shared';

/** The identity a provider returns after successfully verifying credentials. */
export interface ExternalIdentity {
  source: AuthSource;
  /** Stable external id (e.g. LDAP DN). Absent for local accounts. */
  externalId?: string;
  email: string;
  displayName: string;
  isAdmin?: boolean;
}

/**
 * A pluggable authentication backend. Authentication is isolated behind this
 * interface; after any provider succeeds, the app mints its own JWTs, so the
 * rest of the system never depends on the provider.
 */
export interface AuthProvider {
  readonly name: string;
  /** Returns the identity on success, null on invalid credentials. Throws on
   *  infrastructure errors (e.g. directory unreachable) so the caller can fall
   *  back to other providers. */
  authenticate(username: string, password: string): Promise<ExternalIdentity | null>;
}
