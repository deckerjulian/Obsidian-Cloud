/**
 * Typed application configuration loaded from environment variables.
 * Exposed via Nest's ConfigService as nested keys, e.g. `config.get('jwt.accessSecret')`.
 */

function int(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfiguration {
  nodeEnv: string;
  port: number;
  publicUrl: string;
  /** Trust X-Forwarded-For from the first proxy hop (reverse-proxy deploys). */
  trustProxy: boolean;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: number;
    refreshTtl: number;
  };
  auth: {
    providers: string[];
  };
  ldap: {
    url: string;
    bindDn: string;
    bindCredentials: string;
    searchBase: string;
    searchFilter: string;
    attrEmail: string;
    attrDisplayName: string;
    tls: boolean;
    adminGroup: string;
  };
  bootstrap: {
    adminEmail: string;
    adminPassword: string;
  };
}

/** Dev-only fallback secrets. Publicly known (they are in this repo!) —
 *  main.ts refuses to boot in production while any of them is in effect. */
export const DEV_ACCESS_SECRET = 'dev-access-secret-change-me';
export const DEV_REFRESH_SECRET = 'dev-refresh-secret-change-me';
export const DEV_BOOTSTRAP_PASSWORD = 'changeme';

export default (): AppConfiguration => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:8080',
  trustProxy: bool(process.env.TRUST_PROXY, false),
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? DEV_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? DEV_REFRESH_SECRET,
    accessTtl: int(process.env.JWT_ACCESS_TTL, 900),
    refreshTtl: int(process.env.JWT_REFRESH_TTL, 604800),
  },
  auth: {
    providers: list(process.env.AUTH_PROVIDERS, ['local']),
  },
  ldap: {
    url: process.env.LDAP_URL ?? 'ldap://localhost:389',
    bindDn: process.env.LDAP_BIND_DN ?? '',
    bindCredentials: process.env.LDAP_BIND_CREDENTIALS ?? '',
    searchBase: process.env.LDAP_SEARCH_BASE ?? '',
    searchFilter: process.env.LDAP_SEARCH_FILTER ?? '(uid={{username}})',
    attrEmail: process.env.LDAP_ATTR_EMAIL ?? 'mail',
    attrDisplayName: process.env.LDAP_ATTR_DISPLAY_NAME ?? 'cn',
    tls: bool(process.env.LDAP_TLS, false),
    adminGroup: process.env.LDAP_ADMIN_GROUP ?? '',
  },
  bootstrap: {
    adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com',
    adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? DEV_BOOTSTRAP_PASSWORD,
  },
});
