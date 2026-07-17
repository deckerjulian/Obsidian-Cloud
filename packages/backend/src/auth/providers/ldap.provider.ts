import { Injectable, Logger } from '@nestjs/common';
import { Client } from 'ldapts';
import type { AuthProvider, ExternalIdentity } from './auth-provider.interface';
import { AuthConfigService } from '../auth-config.service';

function attrValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  if (v == null) return undefined;
  return String(v);
}

function attrArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v == null) return [];
  return [String(v)];
}

/** RFC 4515 escaping for values interpolated into a search filter. */
function escapeFilter(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Authenticates against an LDAP/AD directory: bind as a service account, find
 * the user entry, then re-bind as that user to verify the password. The user's
 * password is never stored — only a fresh bind per login. Active Directory works
 * the same way (adjust the search filter to sAMAccountName/userPrincipalName).
 */
@Injectable()
export class LdapAuthProvider implements AuthProvider {
  readonly name = 'ldap';
  private readonly logger = new Logger(LdapAuthProvider.name);

  constructor(private readonly authConfig: AuthConfigService) {}

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    const cfg = await this.authConfig.getEffectiveLdap();
    const { url, bindDn, bindCredentials, searchBase, searchFilter, attrEmail } = cfg;
    const attrDisplay = cfg.attrDisplayName;
    const adminGroup = cfg.adminGroup;

    const client = new Client({ url });
    try {
      // 1. Service bind + locate the user entry.
      await client.bind(bindDn, bindCredentials);
      const filter = searchFilter.replace(/\{\{username\}\}/g, escapeFilter(username));
      const { searchEntries } = await client.search(searchBase, {
        filter,
        scope: 'sub',
        attributes: [attrEmail, attrDisplay, 'memberOf'],
      });
      if (searchEntries.length === 0) return null;

      const entry = searchEntries[0];
      const userDn = entry.dn;

      // 2. Verify the password by binding as the user on a fresh connection.
      const userClient = new Client({ url });
      try {
        await userClient.bind(userDn, password);
      } catch {
        return null; // invalid credentials
      } finally {
        await userClient.unbind().catch(() => undefined);
      }

      const email = attrValue(entry[attrEmail]) ?? `${username}@ldap.local`;
      const displayName = attrValue(entry[attrDisplay]) ?? username;
      const memberOf = attrArray(entry['memberOf']);
      // No adminGroup configured → the directory does not manage the admin
      // flag at all (undefined keeps whatever was set via the admin UI).
      // Returning `false` here would demote manually promoted users on every
      // login.
      const isAdmin =
        adminGroup === ''
          ? undefined
          : memberOf.some((g) => g.toLowerCase() === adminGroup.toLowerCase());

      return { source: 'ldap', externalId: userDn, email: email.toLowerCase(), displayName, isAdmin };
    } catch (err) {
      // Infrastructure failure (e.g. directory down): throw so AuthService can
      // fall back to the local provider rather than locking everyone out.
      this.logger.warn(`LDAP error: ${(err as Error).message}`);
      throw err;
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
