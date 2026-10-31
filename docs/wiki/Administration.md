# Administration

Admins open user management in the web app from the vault switcher (bottom left) or from the
account dialog.

## Roles

| Role | Can do |
|---|---|
| **User** | Create vaults (and owns them), work in everything shared with them, share where they hold *share* |
| **Plugin admin** | Like a user, plus: change vaults' Obsidian config (community plugins, their settings, themes, snippets) on the server |
| **Admin** | Everything: see and manage every vault and node, manage users and sign-in, change any vault config, read all content |

## Users

*Admin → Users* lists all accounts with their source (local or LDAP), role, and whether they
may manage plugins in the cloud.

| Action | How |
|---|---|
| Create a local user | *New user*: email, display name, initial password. Optionally tick *Administrator* or *Plugin admin*. |
| Make or revoke admin | *Make admin* / *Revoke admin*. You can't revoke your own admin, and the last admin can't be demoted. |
| Grant or revoke plugin admin | Checkbox in the **Plugins in the cloud** column (admins always have it) |
| Reset a password | *Reset password* (local accounts) |
| Delete a user | *Delete*. This removes the account with its permissions and keys. Their notes stay; admins and other people with access keep their keys. |

New users sign in once and set up their own encryption passphrase. Only then can things be
shared with them.

## Sign-in providers

*Admin → Authentication* switches between local accounts only and local plus
**LDAP / Active Directory**. You set the server URL, bind DN and password, search base and
filter, attribute mapping, and optionally an admin group. Directory users are created on their
first successful sign-in. Settings made here override the `LDAP_*` environment variables; see
[Configuration](Configuration.md#sign-in-providers).

## Admins can read everything

By design, every document's key is also encrypted for every admin:

- new documents when they are created;
- existing documents the next time someone who holds their key syncs after a new admin was
  added.

This gives admins full access for support and recovery, and it is a deliberate relaxation of
the zero-knowledge model. A compromised admin account can read everything, so keep the
number of admins small and protect those accounts well. An admin must have set up encryption
once to receive keys.

## Plugin admins

Community plugins of a vault run in the browser of everyone who opens it. That makes changing
them equivalent to deploying code to those people. Grant **plugin admin** only to people you
trust with that. Details: [Plugins and Vault Config](Plugins-and-Vault-Config.md).

## Housekeeping

- Remove accounts that are no longer needed, especially leftover test admins such as the
  bootstrap `admin@example.com`.
- Content from before vaults existed stays visible to admins as *server tree (without vault)*.
- Backups and updates: see [Backup and Maintenance](Backup-and-Maintenance.md).
