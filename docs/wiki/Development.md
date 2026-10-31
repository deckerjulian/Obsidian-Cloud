# Development

## Repository layout

```
obsidian-cloud/
  packages/
    shared/    @oc/shared   DTOs, capabilities, id-path helpers, isomorphic crypto,
                            the encrypted Yjs provider
    backend/   @oc/backend  NestJS REST API (auth, tree, ACL, documents, blobs, E2EE keys)
                            + zero-knowledge Yjs relay; Prisma + PostgreSQL
    web/       @oc/web      React web app: vault workspace, Obsidian-style renderer,
                            Live Preview editor, Obsidian plugin API shim, admin UI
    plugin/    @oc/plugin   Obsidian plugin (desktop + mobile)
    cli/       @oc/cli      import-vault / verify-vault
  docs/wiki/                this documentation
  docker-compose.yml  Caddyfile  .env.example
```

## Architecture

```
  Browser / Obsidian plugin
        │
      Caddy (:8080)
        │  /          → web      (static React build)
        │  /api/*     → backend  (REST)
        │  /ws/doc/*  → backend  (encrypted Yjs relay)
        ▼
      NestJS → Prisma → PostgreSQL
      (encrypted names, wrapped keys, encrypted Yjs update log, encrypted blobs)
```

- **Tree.** Every node (vault, folder, file) has an encrypted name and an id-chain `path`
  (`<uuid>/<uuid>/…`). Permissions are inherited by path prefix without the server knowing
  any name. A vault is a top-level node with `isVault`. A vault's `.obsidian` folder carries
  `systemType = 'config'`, and inside it `AclService` reduces capabilities to `read` unless the
  user is an admin or has `isPluginAdmin`.
- **Documents.** Note content is a Yjs document. Encrypted updates are appended through the
  WebSocket relay, or in batches over REST (`POST /api/documents/updates`, and
  `POST /api/documents/:docId/updates` for appends with an optional original `mtime`).
- **Keys.** Each node has its own AES-256-GCM content key, wrapped per user with RSA-OAEP.
  See [Encryption](Encryption.md).

### Web app internals (`packages/web/src`)

| Folder | Contents |
|---|---|
| `vault/` | `VaultStore`: the decrypted in-memory vault (paths, content, metadata cache, link resolution), `VaultContext` (tree polling, vault list) |
| `markdown/` | Obsidian-flavoured Markdown → DOM renderer (callouts, embeds, wikilinks, math, Mermaid, code-block processors) |
| `editor/` | CodeMirror 6 editor bound to Yjs; `livePreview.ts` (Live Preview decorations and block widgets), `obsidianSyntax.ts` (Lezer extensions for wikilinks, embeds, highlights, tags, math, comments) |
| `obsidian/` | Obsidian API compatibility layer (`App`, `Vault`, `MetadataCache`, `Workspace`, `Plugin`, `Modal`, `Setting`, …) and `PluginHost`, which loads a vault's community plugins |
| `workspace/` | The Obsidian-like UI: tabs, sidebars, note view, palettes, settings, editor preferences |
| `admin/`, `acl/`, `e2ee/`, `auth/` | Admin area, sharing dialog, key handling, sign-in |

### Plugin internals (`packages/plugin/src`)

| File | Role |
|---|---|
| `main.ts` | Lifecycle, status model, status bar, menu, commands |
| `settings.ts` | Settings tab (status card, sections, sync log) |
| `sync/SyncEngine.ts` | Reconcile (pull, push, delete, rename), live document sessions, prompts |
| `sync/ConfigSync.ts` | One-way upload of the vault's `.obsidian` into the protected config folder |
| `sync/VaultPicker.ts`, `sync/vaultScope.ts` | Vault selection and which server nodes a vault mirrors |
| `e2ee/E2eeManager.ts` | Key setup/unlock, key cache, wrapping |
| `ui/` | Shared UI components, styles, status derivation |
| `i18n.ts` | English and German UI strings |

## Running locally

You need Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install

# PostgreSQL
docker compose up -d postgres
DATABASE_URL="postgresql://obsidian:obsidian@localhost:5432/obsidian_cloud?schema=public" \
  pnpm prisma:migrate

pnpm dev:backend     # NestJS on :3000 (REST /api, relay /ws/doc)
pnpm dev:web         # Vite dev server on :5173, proxies /api and /ws to :3000
pnpm dev:plugin      # esbuild watch → packages/plugin/main.js
```

To run the web app against another backend, set `OC_BACKEND`, e.g.
`OC_BACKEND=https://notes.example.com pnpm --filter @oc/web dev`.

## Checks

```bash
pnpm typecheck       # all packages
pnpm test            # all unit tests (vitest / jest)
pnpm build           # all packages
pnpm --filter @oc/backend test:e2e   # backend e2e (needs DATABASE_URL)
```

The web package also runs real community plugins (Dataview, Templater, Linter, HTML Viewer)
against the API shim. Their builds aren't part of the repository. Put them into
`packages/web/src/obsidian/__tests__/plugin-fixtures/<id>/` (git-ignored) or point
`OC_PLUGIN_FIXTURES` at a folder with `<id>/main.js`, `manifest.json` and `styles.css`.
Without them, that suite is skipped.

## Conventions

- One `yjs` (and CodeMirror core) version is pinned across all packages through
  `pnpm-workspace.yaml` overrides. Multiple Yjs copies break CRDT sync.
- Database changes need a Prisma migration in `packages/backend/prisma/migrations/`.
  Migrations run automatically on backend start.
- `@oc/shared` must be built (`pnpm --filter @oc/shared build`) before the other packages and
  the CLI can use it.
- The plugin bundles its CSS into `main.js`, so installing it means copying `main.js` and
  `manifest.json` only.

## License

AGPL-3.0-or-later. If you run a modified version as a network service, you must offer its
source to its users. See [`LICENCE.md`](../../LICENCE.md).
