# Obsidian Cloud

Self-hosted, multi-user sync for [Obsidian](https://obsidian.md) vaults: end-to-end
encrypted, with per-folder and per-note permissions, real-time collaborative editing, and a
web app that shows your vault the way Obsidian does, community plugins included.

The server only ever stores ciphertext. Note content, file and folder names and attachments
are encrypted on your devices with a passphrase the server never sees.

Obsidian Sync, Self-hosted LiveSync and Remotely Save are single-user tools without a
permission model. Obsidian Cloud is built for teams and for people who want their own server
without giving it their plaintext.

📖 **Documentation: [the wiki](docs/wiki/Home.md)**, covering installation, the Obsidian
plugin, the web app, vaults, plugins, permissions, administration, encryption and
troubleshooting.

## Features

- **End-to-end encryption, zero-knowledge towards the server.**
  - RSA-OAEP user keys and one AES-256-GCM key per document.
  - Names, content and attachments are encrypted client-side.
  - Sharing re-wraps keys for the recipient, with trust-on-first-use key pinning.
  - [How it works](docs/wiki/Encryption.md).
- **Multiple vaults.** Each server vault maps to one Obsidian vault and is shared
  independently. Desktop and mobile sync one vault each; the web app switches between them.
- **Permissions.** Read / create / edit / delete / share capabilities with viewer, editor and
  owner presets, inherited down the tree. New notes in shared folders are keyed for everyone
  automatically.
- **Real-time collaboration.** Yjs (CRDT) over an encrypted WebSocket relay, with live cursors.
  Offline edits merge on reconnect.
- **An Obsidian-like web app.**
  - Workspace: file explorer, tabs, reading view, **Live Preview** and source editing,
    quick switcher, command palette, search (`tag:`, `path:`, `file:`), bookmarks,
    outline and backlinks.
  - Rendering: wikilinks, embeds, callouts, Mermaid, math and properties render as in
    Obsidian.
  - Appearance: the vault's theme, fonts, snippets and readable-line-length settings apply.
- **Your community plugins in the browser.**
  - The vault's plugins and their settings are synced from the desktop and run unmodified,
    for example Dataview and `dataviewjs`, Templater and Linter.
  - The server protects each vault's plugin folder: only admins and **plugin admins** can
    change it, and every browser asks before running plugin code.
- **Obsidian plugin for desktop and mobile.**
  - Guided setup.
  - Merge-only first sync that never deletes.
  - Conflict handling, status bar and sync log.
  - English and German interface.
- **Accounts.**
  - Local accounts (argon2, rotating refresh tokens with reuse detection).
  - Optional LDAP / Active Directory with just-in-time provisioning.
  - Admin and plugin-admin roles.
- **Import tool.** The `import-vault` CLI uploads an existing vault encrypted, preserving
  modification times. It is resumable and comes with a byte-for-byte verifier.
- **One-command deploy.** Docker Compose with PostgreSQL, backend, web app and Caddy.

## Quick start

You need Docker with the Compose plugin.

```bash
git clone https://github.com/deckerjulian/Obsidian-Cloud.git obsidian-cloud
cd obsidian-cloud
cp .env.example .env        # set JWT secrets, DB password and bootstrap admin
docker compose up -d --build
```

Open <http://localhost:8080> on the server:

1. Sign in with the bootstrap admin from `.env` (default `admin@example.com` / `changeme`).
2. Set up end-to-end encryption with a passphrase that is **different** from your password,
   and store it safely. There is no recovery.
3. Change the admin password, then create users or connect LDAP.

Caddy listens on `127.0.0.1:8080` only. To serve a domain over HTTPS, put your reverse proxy
in front, or let Caddy obtain certificates itself. See
[Installation](docs/wiki/Installation.md).

## Connect Obsidian

```bash
pnpm install
pnpm --filter @oc/plugin build
cp packages/plugin/main.js packages/plugin/manifest.json \
   "<your vault>/.obsidian/plugins/obsidian-cloud/"
```

Enable **Obsidian Cloud** under *Settings → Community plugins*. The plugin walks you through
the setup: server, sign-in, encryption, choosing a server vault, first sync. See
[Obsidian Plugin](docs/wiki/Obsidian-Plugin.md).

Already have a large vault? Import it with the CLI first:
[Vaults → Importing](docs/wiki/Vaults.md#importing-an-existing-vault).

## Documentation

| Topic | Page |
|---|---|
| Install, HTTPS, first admin | [Installation](docs/wiki/Installation.md) |
| Environment variables, limits | [Configuration](docs/wiki/Configuration.md) |
| Plugin setup, status bar, settings, conflicts | [Obsidian Plugin](docs/wiki/Obsidian-Plugin.md) |
| Workspace, Live Preview, shortcuts, search | [Web App](docs/wiki/Web-App.md) |
| Multiple vaults, importing | [Vaults](docs/wiki/Vaults.md) |
| Community plugins in the browser, plugin admins | [Plugins and Vault Config](docs/wiki/Plugins-and-Vault-Config.md) |
| Capabilities, sharing, revoking | [Permissions and Sharing](docs/wiki/Permissions-and-Sharing.md) |
| Users, roles, LDAP | [Administration](docs/wiki/Administration.md) |
| Key hierarchy, threat model | [Encryption](docs/wiki/Encryption.md) |
| What syncing does and why it's safe | [Sync Behavior](docs/wiki/Sync-Behavior.md) |
| Backups, updates | [Backup and Maintenance](docs/wiki/Backup-and-Maintenance.md) |
| Common problems | [Troubleshooting](docs/wiki/Troubleshooting.md) |
| Code layout, local development, tests | [Development](docs/wiki/Development.md) |

## Tech stack

- TypeScript end to end, as a pnpm monorepo (Node 22+).
- Backend: NestJS 11, Prisma, PostgreSQL, and a custom zero-knowledge Yjs relay on `ws`.
- Web: React 19, Vite 6, CodeMirror 6 with Live Preview, Yjs (`y-codemirror.next`), `marked`,
  KaTeX, Mermaid.
- Plugin: Obsidian API, esbuild, Yjs.
- Crypto: Web Crypto API, using RSA-OAEP 2048, PBKDF2 (600k iterations) and AES-256-GCM.
- Infra: Docker Compose and Caddy.

```
packages/
  shared/   DTOs, capabilities, crypto, encrypted Yjs provider
  backend/  REST API + encrypted relay (NestJS, Prisma, PostgreSQL)
  web/      web app, Live Preview editor, Obsidian API shim, admin UI
  plugin/   Obsidian plugin
  cli/      import-vault / verify-vault
docs/wiki/  documentation
```

Development setup and checks are described in [Development](docs/wiki/Development.md):

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

## Security at a glance

- **Zero-knowledge towards the server.** It stores encrypted names, content and keys, and
  sees only structure (node count, nesting, sizes, timestamps, who shares with whom).
- **Admins can read everything by design.** Every document key is also wrapped for every
  admin. Keep the number of admins small.
- **Plugin code runs with access to decrypted notes.** Only admins and plugin admins can change
  a vault's plugins, and every browser asks before running them.
- **A lost passphrase can't be recovered by the server.** Content that an admin or another
  grantee still holds can be re-shared.
- **Production hardening.** Production refuses default JWT secrets, and sign-in is
  rate-limited.

Details: [Encryption → Trust model and limitations](docs/wiki/Encryption.md#trust-model-and-limitations).

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See
[`LICENCE.md`](LICENCE.md). If you run a modified version as a network service, you must make
its source available to its users.
