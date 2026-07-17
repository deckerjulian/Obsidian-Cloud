/** LDAP/AD configuration as shown to an admin (the bind password is never returned). */
export interface LdapConfigDto {
  url: string;
  bindDn: string;
  searchBase: string;
  searchFilter: string;
  attrEmail: string;
  attrDisplayName: string;
  tls: boolean;
  adminGroup: string;
  /** Whether a bind password is currently stored. */
  bindCredentialsSet: boolean;
}

/** `GET /api/admin/auth-config`. */
export interface AuthConfigDto {
  /** Enabled providers in priority order, e.g. ['local','ldap']. */
  providers: string[];
  ldap: LdapConfigDto;
}

/** `PUT /api/admin/auth-config`. Omitted fields keep their current value. */
export interface UpdateAuthConfigRequest {
  providers?: string[];
  ldap?: {
    url?: string;
    bindDn?: string;
    /** Write-only; omit (or send empty) to keep the existing password. */
    bindCredentials?: string;
    searchBase?: string;
    searchFilter?: string;
    attrEmail?: string;
    attrDisplayName?: string;
    tls?: boolean;
    adminGroup?: string;
  };
}
