# Obsidian Cloud Wiki

Obsidian Cloud is a self-hosted, multi-user sync server for [Obsidian](https://obsidian.md)
vaults. It is end-to-end encrypted, supports per-folder and per-note permissions and
real-time collaborative editing. A web app lets you read and edit your vaults in a browser,
with your community plugins.

> The server only ever stores ciphertext. Names, notes and attachments are encrypted on your
> devices with a passphrase the server never sees.

## Where to start

| I want to… | Read |
|---|---|
| Run my own server | [Installation](Installation.md) → [Configuration](Configuration.md) |
| Connect Obsidian on my computer or phone | [Obsidian Plugin](Obsidian-Plugin.md) |
| Use my vault in the browser | [Web App](Web-App.md) |
| Bring an existing vault to the server | [Vaults](Vaults.md#importing-an-existing-vault) |
| Share notes with other people | [Permissions and Sharing](Permissions-and-Sharing.md) |
| Run my community plugins in the browser | [Plugins and Vault Config](Plugins-and-Vault-Config.md) |
| Manage users and roles | [Administration](Administration.md) |
| Understand what the server can and cannot see | [Encryption](Encryption.md) |
| Understand what happens when I sync | [Sync Behavior](Sync-Behavior.md) |
| Back up or update the server | [Backup and Maintenance](Backup-and-Maintenance.md) |
| Fix a problem | [Troubleshooting](Troubleshooting.md) |
| Work on the code | [Development](Development.md) |

## Key concepts

- **Server.** One Docker Compose deployment: PostgreSQL, a NestJS backend (REST API and an
  encrypted real-time relay), the web app, and Caddy as the single entry point.
- **Account.** Every person signs in with a login password, either a local account or
  LDAP / Active Directory. Separately, each person has an **encryption passphrase** that
  unlocks their personal key pair.
- **Vault.** A top-level folder on the server that corresponds to one Obsidian vault. A
  desktop or mobile vault syncs with exactly one server vault. The web app can switch between
  all vaults you have access to.
- **Permissions.** Capabilities (read, create, edit, delete, share) granted on folders or notes
  and inherited downwards.
- **Vault config.** Each vault's `.obsidian` folder (community plugins, their settings, themes,
  snippets) is synced from the desktop so the web app looks and works the same. Only admins
  and **plugin admins** can change it on the server.

## Pages

1. [Installation](Installation.md)
2. [Configuration](Configuration.md)
3. [Obsidian Plugin](Obsidian-Plugin.md)
4. [Web App](Web-App.md)
5. [Vaults](Vaults.md)
6. [Plugins and Vault Config](Plugins-and-Vault-Config.md)
7. [Permissions and Sharing](Permissions-and-Sharing.md)
8. [Administration](Administration.md)
9. [Encryption](Encryption.md)
10. [Sync Behavior](Sync-Behavior.md)
11. [Backup and Maintenance](Backup-and-Maintenance.md)
12. [Troubleshooting](Troubleshooting.md)
13. [Development](Development.md)

> These pages live in the repository under `docs/wiki/`. They use plain Markdown links, so you
> can read them on GitHub directly or copy them into the repository's GitHub Wiki.
