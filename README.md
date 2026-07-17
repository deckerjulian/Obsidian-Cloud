# Obsidian-Cloud

Self-hosted, multi-user Obsidian sync with per-folder and per-document
permissions, real-time collaborative editing (Yjs/CRDT), a full web editor, and
end-to-end encryption. The server only ever stores ciphertext.

It fills a gap in the Obsidian ecosystem. Obsidian Sync, Self-hosted LiveSync
and Remotely Save are all single-user and multi-device, with no permission model
and no zero-knowledge encryption.

A note on the encryption before anything else: content, file and folder names,
and attachments are all encrypted client-side with a passphrase that is separate
from your login password — the server only ever stores ciphertext and can never
read your data. The one exception is admins: by policy they hold the keys to
every document and can read all content (see [Administration](#7-administration)).
Keep your passphrase safe — it protects your own key material, and there is no
server-side recovery.

## Features

- End-to-end encryption, zero-knowledge (against the server). Each user has an
  RSA key pair; each document has its own AES-256-GCM content key, bound to its
  purpose (name / blob / update / awareness) as AES-GCM additional data. Note
  content, file and folder names, and binary attachments are all encrypted
  client-side. Sharing re-wraps the document key for the recipient, so the
  server never sees a plaintext key.
- Multi-user with granular permissions. A capability model
  (read / create / edit / delete / share) with viewer / editor / owner presets,
  inherited down the folder tree. New notes in a shared folder are automatically
  keyed for everyone who already has access. Admins can read all files.
- Real-time collaboration. Live cursors and conflict-free merging (Yjs/CRDT)
  over an encrypted WebSocket relay that never sees plaintext.
- Web editor. CodeMirror 6 with a formatting toolbar and a live Markdown preview
  (front-matter, GFM tables, callouts, headings, lists, and so on).
- Obsidian plugin for desktop and mobile. Two-way vault sync that respects
  permissions, with a status bar, sync indicator, and on-device key storage.
- Auth. Local accounts (argon2 with rotating JWT refresh tokens and reuse
  detection), plus optional LDAP / Active Directory with just-in-time
  provisioning.
- Central plugin distribution. An admin-managed folder distributes Obsidian
  plugins (code only, never settings) automatically to every user's vault.
- One-command deploy with Docker Compose (PostgreSQL, backend, web, Caddy).

## Tech stack

- Language: TypeScript end-to-end (pnpm monorepo, Node 22+).
- Backend: NestJS 11, Prisma ORM, PostgreSQL, and a custom zero-knowledge Yjs
  relay built on `ws`.
- Web: React 19, Vite 6, CodeMirror 6, Yjs with `y-codemirror.next`, `marked`.
- Plugin: Obsidian API, esbuild, Yjs.
- Crypto: Web Crypto API — RSA-OAEP 2048, PBKDF2 (600k iterations), AES-256-GCM.
- Auth: `@nestjs/jwt`, `@node-rs/argon2`, `ldapts` for LDAP/AD.
- Infra: Docker Compose, Caddy for reverse proxy and TLS.

## Repository layout

```
obsidian-cloud/
  packages/
    shared/    @oc/shared   DTOs, capabilities, path helpers,
                            isomorphic crypto, the encrypted Yjs provider
    backend/   @oc/backend  NestJS REST API (auth, tree, ACL, blobs, E2EE keys)
                            plus the zero-knowledge Yjs relay; Prisma + PostgreSQL
    web/       @oc/web      React web editor and admin UI
    plugin/    @oc/plugin   Obsidian plugin (desktop + mobile)
  docker-compose.yml   Caddyfile   .env.example
  pnpm-workspace.yaml  package.json
  README.md
```

### Architecture

Caddy sits in front on port 8080 and routes everything:

```
  Browser / Obsidian plugin
        |
      Caddy (:8080)
        |  /          -> web      (React build)
        |  /api/*     -> backend  (REST: auth, tree, ACL, ...)
        |  /ws/doc/*  -> backend  (encrypted Yjs relay)
        v
      NestJS -> Prisma -> PostgreSQL
      (stores only ciphertext: encrypted names, wrapped keys,
       encrypted Yjs update log, blobs)
```

The server is structure-aware but content-blind. It enforces who may access
which node — using an id-based path, so names stay secret — and relays encrypted
updates, but it can never decrypt names, content, or attachments.

## Quick start (Docker)

You need Docker and Docker Compose.

```bash
git clone <your-repo-url> obsidian-cloud
cd obsidian-cloud

cp .env.example .env
# Edit .env. At minimum set strong secrets:
#   JWT_ACCESS_SECRET / JWT_REFRESH_SECRET   (e.g. openssl rand -base64 48)
#   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD

docker compose up -d --build
```

Then open http://localhost:8080 and:

1. Sign in with the bootstrap admin (default `admin@example.com` / `changeme`).
2. You'll be prompted to set up end-to-end encryption. Choose a separate
   encryption passphrase, not your login password. Keep it safe — it's the only
   thing that can decrypt your vault.
3. Change the admin password from the account dialog.

To enable LDAP/AD, set `AUTH_PROVIDERS=local,ldap` and the `LDAP_*` variables in
`.env`, then run `docker compose up -d`. A throwaway test directory is available
with `docker compose --profile ldap up`.

For production, put Caddy behind a real domain for automatic HTTPS, set strong
secrets, and change the bootstrap admin password immediately.

## Installing the Obsidian plugin

The plugin is a separate artifact you drop into your vault.

```bash
pnpm install
pnpm --filter @oc/plugin build      # produces packages/plugin/main.js
```

Copy `packages/plugin/main.js` and `packages/plugin/manifest.json` into:

```
<your-vault>/.obsidian/plugins/obsidian-cloud/
```

Then in Obsidian, go to Settings, Community plugins, and enable Obsidian Cloud.
Open the plugin settings, set the server URL (for example
`http://localhost:8080`), sign in, and unlock encryption with your passphrase.
The status bar at the bottom right shows the connection, last-sync time, and
encryption state; click it for a menu (Sync, Encryption, Settings, Sign out).

## User manual

A complete walkthrough, from an empty server to a collaborating team.

1. [Installation](#1-installation)
2. [First-run setup (admin)](#2-first-run-setup-admin)
3. [Connecting Obsidian](#3-connecting-obsidian)
4. [Working with notes](#4-working-with-notes)
5. [Permissions and sharing](#5-permissions-and-sharing)
6. [Central plugin distribution](#6-central-plugin-distribution)
7. [Administration](#7-administration)
8. [How syncing behaves](#8-how-syncing-behaves)
9. [Troubleshooting](#9-troubleshooting)
10. [Backup and maintenance](#10-backup-and-maintenance)

### 1. Installation

Server — follow [Quick start (Docker)](#quick-start-docker) above. One
`docker compose up -d --build` brings up PostgreSQL, the backend (REST plus the
realtime relay), the built web app, and Caddy on port 8080. Database migrations
run automatically on every backend start.

Web app — nothing to install; open `http://<your-server>:8080` (or your domain)
in a browser.

Obsidian plugin — build once, then copy two files into each vault:

```bash
pnpm install && pnpm --filter @oc/plugin build
cp packages/plugin/main.js packages/plugin/manifest.json \
   <your-vault>/.obsidian/plugins/obsidian-cloud/
```

Enable it under Settings, Community plugins, Obsidian Cloud. It works on desktop
and mobile — the plugin uses Obsidian's CORS-free HTTP API.

### 2. First-run setup (admin)

1. Open the web app and sign in with the bootstrap admin
   (`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` from `.env`; default
   `admin@example.com` / `changeme`).
2. You are prompted to set up end-to-end encryption. Choose an encryption
   passphrase. This is deliberately not your login password — the server sees
   the login password during authentication, so it must never be the thing that
   derives your encryption key. Write the passphrase down; without it your data
   is unrecoverable, even for admins.
3. Change the admin password (account menu, Change password).
4. Create accounts for your team under Admin, Users, New user (email, display
   name, initial password). See [Administration](#7-administration) for LDAP
   instead of local accounts.
5. Each new user signs in once and sets up their own encryption passphrase. This
   creates their personal key pair, which is required before anything can be
   shared with them.

### 3. Connecting Obsidian

1. Open the plugin settings and enter the server URL (for example
   `https://obsidian.example.com`). When you leave the field, the plugin checks
   the URL against the server's health endpoint and tells you whether it is
   reachable.
2. Run the Sign in / out command, or click the cloud icon. The sign-in dialog
   re-checks the server and only enables Sign in once the server responds; fix
   the URL and press Check again if it doesn't.
3. Enter your username and password. Sign-in automatically tries every
   configured authentication provider, so there is nothing else to pick.
4. Unlock encryption with your passphrase when prompted. The unlocked key is
   stored on the device as a non-extractable key, so you won't be asked again on
   every restart — only after Lock encryption or signing out.
5. The status bar at the bottom right shows the sync state (green dot for
   online, a spinner while syncing, red for an error), the last sync time, and a
   lock icon for the encryption state. Click it for a quick menu (Sync now, Lock
   encryption, Settings, Sign out).

On the first sync the plugin merges the server tree with your vault: server
items are created locally, local-only files are uploaded (subject to your
permissions), and identical paths are matched up. Nothing is deleted on either
side during this initial sync — a file missing on one side is copied to it, not
removed from the other.

### 4. Working with notes

- Create, rename, move, and delete in either place. On the web, use the buttons
  in the Files sidebar (hover a row for its actions). In Obsidian, just work in
  your vault; structure changes push live, and server-side changes appear within
  one poll interval. Names are stored encrypted, and text notes must end in
  `.md`.
- Edit together by opening the same note in the web editor and one or more
  Obsidian clients. Keystrokes merge conflict-free (CRDT) in real time, and you
  see collaborators' cursors with their names. The web editor has a formatting
  toolbar and a rendered Preview toggle.
- Attachments (images, PDFs, and so on) sync as encrypted binaries up to 32 MB.
- Offline, keep writing. Local persistence records your edits and they merge
  when the connection returns. If both sides changed the same note while apart,
  the plugin asks whether to keep both (a conflict copy), take the server
  version, or take the local version. This is configurable under Ask how to
  handle sync problems.
- When a file can't or shouldn't sync, the problem prompt offers Never sync this
  file. Undo that in the plugin settings under Excluded from sync.

### 5. Permissions and sharing

Access is a set of capabilities on a node, inherited down the tree. The most
specific grant (the deepest node) wins.

- read — see the node, open and download content.
- create — create files and folders inside a folder.
- edit — change content, rename.
- delete — delete the node and its subtree.
- share — grant or revoke access for other users.

The presets are just bundles: viewer is read; editor is read, create, and edit;
owner is everything.

- To share a folder or note on the web, hover the row, click Share, pick the
  user, and choose a preset or individual capabilities, then Grant access. This
  does two things at once: it writes the server-side ACL entry and it shares the
  E2EE keys, since your client re-wraps the subtree's content keys for the
  recipient. The dialog reports how many keys were shared. It also shows the
  recipient's key fingerprint: the first time you share with someone their key
  is trusted (TOFU) and pinned; if it later changes, sharing is blocked until
  you verify and re-trust it — a defence against the server swapping in its own
  key.
- New notes are keyed automatically. When you create a note or attachment inside
  a folder that others already have access to, its content key is wrapped for
  those grantees (and for admins) at creation — no re-share needed. This applies
  to notes created in either the web app or the Obsidian plugin. Notes that
  existed *before* a grant still need a one-time re-share to distribute their
  keys.
- For whole-vault permissions, use the share icon in the Files header. That's
  the grant on the invisible vault root, which everything inherits unless
  overridden deeper.
- To revoke, open the same dialog and choose Remove. This deletes the ACL entry
  and the user's wrapped keys (the server refuses to delete the last remaining
  key for a document, which would make it unrecoverable). The standard E2EE
  caveat applies: it stops future access, but content they already decrypted
  must be assumed known to them.
- What read-only feels like in Obsidian: without edit you can open the note but
  typing is blocked with a notice. If some other program changes the file
  anyway, it is reverted to the server state on the next sync. If your access is
  revoked while a note is open, it becomes read-only within one poll interval.
- A user must have signed in and set up encryption once, so their public key
  exists, before you can share with them (or before they can be keyed in
  automatically).

### 6. Central plugin distribution

You can distribute a curated set of Obsidian plugins to the whole team. The
central plugin folder is special: it is **managed by admins and automatically
distributed to everyone**, no per-user sharing required.

Set up (admin, once): in the web Files header, click the package icon and
confirm. This creates the central plugin folder. It is shown and editable **only
to admins** in the web app; every other user never sees a row for it but still
receives its contents through the Obsidian plugin.

Publish a plugin (admins): in Obsidian, run "Publish a plugin to the central
folder" and pick one of your locally installed plugins. Its `main.js`,
`manifest.json`, and `styles.css` are uploaded encrypted. The `data.json`
(plugin settings) is never synced — it may contain API keys, and settings stay
personal. Re-run the command any time to publish an update.

Receive (everyone): nothing to do. Every user's next sync downloads the managed
plugins into `.obsidian/plugins/` and enables them; a notice asks you to reload
Obsidian once. The server hands the plugin folder to all users (with read-only
access and the keys); their own locally installed plugins are never touched or
removed. A user who joins later is keyed in on the next admin sync.

One security note: an admin can ship code that runs inside every member's
Obsidian. Admin of this instance is effectively deploy access to every vault.

### 7. Administration

Admins see an Admin area in the web app.

- Users — create local users, reset passwords, delete accounts. Deleting a user
  removes their grants and wrapped keys.
- Authentication — switch providers at runtime: local only, or local plus LDAP /
  Active Directory (server URL, bind DN, search base and filter). LDAP users are
  provisioned on their first successful login.
- Admins have full access to every file. They see the whole tree, manage
  everything, and — by policy — can read all content: whenever a document's
  content key is created it is also wrapped for every admin's public key (new
  documents automatically; existing ones the first time each key-holder syncs
  after an admin is added). An admin must have set up their own encryption
  passphrase once (so a public key exists) to receive these keys. Note the
  trade-off: this deliberately relaxes the zero-knowledge guarantee for admins —
  a compromised admin account can read everything.

### 8. How syncing behaves

- The plugin polls the tree in the background (every 20 seconds by default,
  configurable from 5 to 120 seconds; ETag/304 keeps idle polls free) and also
  reacts to live vault events immediately.
- The initial sync is a pure merge: it pulls everything you have access to,
  uploads your local-only files, and deletes nothing on either side. A file
  that is on the server but not local is downloaded, never treated as a
  deletion — so a fresh device never wipes the server. From the second sync on,
  a genuine local deletion propagates to the server as a deletion.
- The web file tree updates itself. The web app polls the tree (ETag/304, every
  ~10 seconds, paused when the tab is hidden), so files created, renamed, or
  deleted from the Obsidian plugin or another browser appear automatically.
  Open notes already update live over the collaborative channel.
- Content flows through per-note live sessions (encrypted Yjs). Up to 12
  sessions stay open, and least-recently-used ones are closed automatically.
- The sync log (plugin settings, Sync log) shows every pull, push, and error
  with timestamps — the first place to look when something seems off.
- Sync now forces a full reconcile via the command palette, the cloud menu, or
  the settings button. It also re-asks previously deferred conflict prompts.
- Renames and moves are mirrored as renames, so backlinks survive. Server-side
  deletions move local files to the trash; a file deleted locally while Obsidian
  was closed is propagated to the server on the next sync (unless it looks like
  a reset vault, where none of the tracked files are present — then it pulls
  instead). Deletions are paused whenever any server item's name cannot be
  decrypted — a missing key must never look like a deletion.

### 9. Troubleshooting

- "Server not reachable — check the URL" — the health check failed: wrong URL,
  missing `https://`, server down, or a proxy stripping `/api`. Fix the URL in
  the plugin settings; sign-in stays disabled until it responds.
- "... is read-only — you don't have edit permission" — you lack edit on that
  note. Ask an owner to grant it via the Share dialog.
- "... is now read-only (edit access revoked)" — someone revoked your edit while
  the note was open.
- "N server item(s) skipped — names could not be decrypted" — you have no key
  for those items (nothing was shared with you yet), or encryption is locked.
  Deletions and uploads pause while this persists. Have the owner share the
  folder with you, and unlock encryption.
- "(unnamed)" row in the web tree — a node with an empty or undecryptable name
  (bad data from an old client). Delete it via its trash button.
- "No encryption key for ... (not shared with you yet)" — you can see the node
  (ACL) but got no content key. The granter must share again while their
  encryption is unlocked.
- Note opens empty in the web — encryption is locked (unlock via the status bar)
  or no key was shared for that note.
- Changes don't appear on another device — check both status bars are green and
  online, then Sync now. Consult the sync log.
- Managed plugin doesn't start after sync — reload Obsidian (the notice asks for
  it); plugins are enabled but only load after a reload.

### 10. Backup and maintenance

- What to back up: the PostgreSQL volume (`pgdata`) is everything, besides your
  `.env`. For example, `docker compose exec postgres pg_dump -U obsidian
  obsidian_cloud > backup.sql`. The dump is ciphertext without the users'
  passphrases — that's the point, but it also means backups don't save you from
  a lost passphrase.
- Update the server: `git pull && docker compose up -d --build`. Migrations
  apply automatically on backend start.
- Update the plugin: rebuild with `pnpm --filter @oc/plugin build`, copy
  `main.js` into the vaults, and reload Obsidian. Or publish it through the
  central plugin folder and let it distribute itself.
- Full reset (dev): `docker compose down -v && docker compose up -d --build`
  wipes the database, including all users, keys, and content.

## Development

You need Node 22+ and pnpm 11+ (`corepack enable`).

```bash
pnpm install

# 1. Start PostgreSQL (Docker is easiest):
docker compose up -d postgres

# 2. Apply database migrations:
DATABASE_URL="postgresql://obsidian:obsidian@localhost:5432/obsidian_cloud?schema=public" \
  pnpm prisma:migrate

# 3. Run the pieces you need (each first builds @oc/shared):
pnpm dev:backend     # NestJS on :3000  (REST under /api, relay under /ws/doc)
pnpm dev:web         # Vite dev server (set VITE_API_BASE if the backend is elsewhere)
pnpm dev:plugin      # esbuild watch -> packages/plugin/main.js
```

Workspace scripts:

```bash
pnpm build           # build every package
pnpm typecheck       # type-check every package
pnpm test            # run all unit tests
```

A single `yjs` (and CodeMirror core) version is pinned across all packages via
the `overrides` in `pnpm-workspace.yaml` — multiple Yjs copies break CRDT sync.

## Configuration

All backend configuration is via environment variables (see
[`.env.example`](.env.example)):

- `PUBLIC_URL` — public base URL (CORS allow-list; the web app's expected
  origin).
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — the Compose Postgres
  container and the `DATABASE_URL` are built from these.
- `DATABASE_URL` — PostgreSQL connection string (used directly when running the
  backend outside Compose).
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — JWT signing secrets. In production
  the backend refuses to boot while these are the repo defaults; set strong
  values (`openssl rand -base64 48`).
- `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` — token lifetimes in seconds.
- `AUTH_PROVIDERS` — comma-separated, for example `local` or `local,ldap`.
- `LDAP_*` — LDAP/AD connection and attribute mapping (when `ldap` is enabled).
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — first-run admin, created
  only if no users exist.

Default ports: 8080 for Caddy (everything). PostgreSQL is not published to the
host by default (reachable only on the internal Compose network); uncomment the
`ports` mapping in `docker-compose.yml` if you need direct access.

## How the end-to-end encryption works

Everything below happens client-side (in the browser or the Obsidian plugin)
with the Web Crypto API. The shared implementation lives in
[`packages/shared/src/crypto.ts`](packages/shared/src/crypto.ts). The server
never imports this module; it only stores and forwards the opaque base64 strings
the clients produce.

### The key hierarchy

There are three layers of keys. Only the bottom layer touches actual data.

```
  E2EE passphrase  (never leaves the device, never sent to the server)
        |  PBKDF2-SHA256, 600,000 iterations, 16-byte random salt
        v
  Wrapping key  (AES-256-GCM, derived on the fly, never stored anywhere)
        |  AES-GCM-wraps...
        v
  User key pair  (RSA-OAEP 2048, SHA-256 — one per user)
        |  RSA-wraps, one copy per authorised user...
        v
  Document content key  (AES-256-GCM — one random key per document)
        |  AES-GCM-encrypts...
        v
  note content (Yjs updates) / file and folder name / binary attachment
```

- The user key pair is created once, on first encryption setup. The private key
  is exported (PKCS8) and AES-GCM-encrypted with the wrapping key; only the
  ciphertext, the public key (SPKI), and the PBKDF2 salt are uploaded
  (`POST /api/e2ee/keys`, `user_keys` table). The server can verify none of it.
- The content key: every node (note, folder, attachment) gets its own random
  AES-256-GCM key when it is created. The creator wraps it with their own RSA
  public key and stores the wrapped copy server-side
  (`PUT /api/e2ee/document-keys/:docId`, `document_keys` table, one row per
  `(docId, userId)`), and also wraps it for anyone who already has access to the
  parent folder and for all admins (see [Sharing](#sharing-and-revoking)).
- Every content AES-GCM ciphertext is a versioned envelope
  `[0x01][12-byte IV][ciphertext+tag]`, with the ciphertext's **purpose**
  (`name` / `blob` / `yupdate` / `awareness`) bound as AES-GCM additional
  authenticated data. Under one content key a name, a blob and a Yjs update are
  therefore not interchangeable — the relay can't re-type or swap one for
  another without failing authentication. Legacy ciphertext written before this
  envelope (bare `[IV][ciphertext]`, no purpose) is still read via a fallback,
  so no migration is needed.

### Setup, unlock, and device persistence

- Setup (first time): generate the RSA pair, derive the wrapping key from the
  passphrase, and upload `{publicKey, encryptedPrivateKey, kdfSalt}`. The
  passphrase itself is never transmitted — deliberately separate from the login
  password, which the server does see during authentication.
- Unlock (new device or after lock): fetch the wrapped key material
  (`GET /api/e2ee/keys/me`), re-derive the wrapping key from the entered
  passphrase, and unwrap the private key locally. A wrong passphrase simply
  fails the AES-GCM authentication check — the server is not involved.
- Persistence: the unlocked key pair is cached in IndexedDB as non-extractable
  `CryptoKey` objects, so relaunching Obsidian or reloading the web app doesn't
  re-prompt for the passphrase. Lock or sign out clears it. Unwrapped content
  keys are additionally cached in memory per session, and the plugin bulk-fetches
  all wrapped keys in one request (`GET /api/e2ee/document-keys`) before a sync
  run to avoid N+1 requests.

### What the server stores, and what it can read

The server sees structure but not names or content:

- Tree structure — node ids, parent links, id-based paths, kind, depth: visible
  (structure only).
- File and folder names: AES-GCM ciphertext.
- Note content: a log of AES-GCM-encrypted Yjs updates (`doc_updates`).
- Binary attachments: AES-GCM ciphertext blobs, plus a sha256 of the ciphertext.
- User keys: public key, plus passphrase-wrapped private key and salt.
- Document keys: RSA-wrapped copies, one per authorised user.
- ACL (who may read, edit, or share which subtree): visible, enforced
  server-side.

Because names are ciphertext, the server can't build name-based paths. The
materialized path of every node is an id-chain (`<uuid>/<uuid>/...`), so the
server can enforce subtree permissions without learning a single name. Clients
rebuild the human-readable tree by decrypting each name along the parent chain
with the respective document key.

The server is therefore structure-aware but content-blind: it knows that you
have 240 nodes, how they nest, and who may access which subtree, but it can
never know what any of them are called or contain.

### Real-time collaboration on ciphertext

Live editing uses Yjs (CRDT), but the WebSocket relay (`/ws/doc/:docId`) is
zero-knowledge — see
[`packages/shared/src/yjs-provider.ts`](packages/shared/src/yjs-provider.ts):

1. A client edits the note, and Yjs produces a binary update.
2. The `EncryptedProvider` AES-GCM-encrypts the update with the document's
   content key and sends it as an opaque frame.
3. The relay checks the sender's JWT and ACL (edit capability for writes, read
   for connecting), appends the ciphertext to the document's update log, and
   forwards it to every other connected client.
4. Receiving clients decrypt and call `Y.applyUpdate()`. CRDT semantics merge
   concurrent edits without a central authority ever seeing plaintext.

Awareness messages (live cursors, names, and colors of collaborators) travel
over the same channel and are encrypted the same way.

Compaction: the update log would grow forever, so after a threshold of appended
updates a writable client periodically replaces the whole log with one snapshot
update (a `T_REPLACE` frame), computed and encrypted client-side, so compaction
is zero-knowledge too. Read-only connections may not compact.

Offline edits merge through the same mechanism. Each client persists its Yjs
state locally (IndexedDB), and on reconnect the server replays the encrypted
update log; a three-way seed decision (last-synced state, local file, server
state) decides whether to pull, push, or ask the user to resolve a conflict.

### Sharing and revoking

Granting someone access to a subtree does two things:

1. ACL entry (server-enforced): the recipient gets capabilities (read, create,
   edit, delete, share) on the node, inherited by the subtree.
2. Key sharing (client-side): the granter unwraps the content key of every
   document in the subtree with their private key and re-wraps each one with the
   recipient's RSA public key (`GET /api/e2ee/public-keys` provides the public
   keys). The wrapped copies are uploaded, and the recipient can now decrypt
   names and content. The recipient's public key is trusted-on-first-use and
   pinned locally; a later change blocks sharing until you re-verify it, so a
   malicious server cannot silently substitute its own key to intercept a share.

Both steps happen together in the web Share dialog. Some consequences of the
design:

- A user must have set up encryption once, so a public key exists, before
  anything can be shared with them.
- Ongoing keying is automatic. A note created inside an already-shared folder is
  keyed for the folder's existing grantees at creation (the server returns the
  co-grantees' public keys via `GET /api/e2ee/grantees/:docId`), so new content
  doesn't need a manual re-share. Adding keys for a user is allowed without the
  `share` capability when that user is already entitled to read the subtree.
- Admins are implicit readers of every document: each content key is wrapped
  for all admins (new docs at creation; existing docs when a key-holder next
  syncs — the client re-keys its own documents for the admin set via
  `GET /api/e2ee/admin-keys`). Admins therefore read all content — a deliberate
  relaxation of the zero-knowledge model in exchange for full administrative
  access.
- Revoking removes the ACL entry and deletes the recipient's wrapped key copies
  (the server refuses to delete the last key for a document, and won't strip
  keys the user still holds through a separate deeper grant). The usual E2EE
  caveat applies: revocation prevents future access, but content the recipient
  already decrypted while authorised must be assumed known to them (the content
  keys are not rotated on revoke).

### Trust model and limitations

- Protected against: a curious or compromised server or hosting provider,
  database leaks, and any network observer. All of them only ever see ciphertext,
  wrapped keys, and structural metadata.
- Not protected against: a compromised client (malware on a device with an
  unlocked vault), weak passphrases (PBKDF2 slows brute force by roughly 600k
  times, but it doesn't fix `hunter2`), or a malicious build of the web app
  served by a compromised host — self-hosting the web client is part of the
  trust assumption.
- Metadata is visible by design: node count, tree shape, sizes, timestamps, and
  who shares with whom. Names, content, and attachments are not.
- Recovery is limited and never server-side. Your passphrase wraps your private
  key; lose it on every device at once and you lose access to your own key pair.
  Documents that another key-holder still has (an admin — who holds keys to
  everything — or another grantee) can be re-shared back to you once you set up a
  new passphrase; a document that only you ever held a key for is gone for good.
  The server can recover nothing: it has no passphrase and no plaintext.

## Security notes

- Zero-knowledge against the server. The encryption passphrase is separate from
  the login password, because the server sees the login password and so it must
  not derive the encryption key. The server only ever stores ciphertext.
- Admins are trusted readers. By policy admins hold the keys to every document
  and can read all content — a deliberate relaxation of zero-knowledge in
  exchange for full administrative access. A compromised admin account can read
  everything.
- A lost passphrase locks you out of your own key material; only content another
  key-holder (an admin or a grantee) still has can be recovered — by re-sharing.
  There is no server-side recovery.
- Trade-offs. Because the server is content-blind, there is no server-side
  full-text search, name sorting, or preview without unlocking, and file-name
  uniqueness is not enforced server-side.
- Production refuses to start with the default `JWT_*` secrets; always set strong
  values and change the bootstrap admin password before exposing the deployment.
  `/api/auth/login` is rate-limited.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See
[`LICENCE.md`](LICENCE.md) for the full text.

The AGPL is the fitting copyleft for self-hosted network software: if you run a
modified version of Obsidian-Cloud as a service that others interact with over a
network, you must make the corresponding source of your modified version
available to them.
