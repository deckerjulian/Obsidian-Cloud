# Configuration

The backend is configured with environment variables. Docker Compose reads them from `.env`
in the repository root; copy [`.env.example`](../../.env.example) to start. After a change,
run `docker compose up -d` to apply it.

## General

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:8080` | Public base URL. Used as the allowed browser origin (CORS). |
| `NODE_ENV` | `development` | Use `production` for real deployments. Production refuses default JWT secrets. |
| `PORT` | `3000` | Backend port inside the container network. |
| `TRUST_PROXY` | `false` | Set to `true` only if the backend sits behind a reverse proxy and isn't reachable directly. Rate limiting then uses `X-Forwarded-For`. |

## Database

| Variable | Default | Description |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `obsidian` / `obsidian` / `obsidian_cloud` | Used by the Compose Postgres container. Compose builds the backend's database URL from them. |
| `DATABASE_URL` | `postgresql://obsidian:obsidian@localhost:5432/obsidian_cloud?schema=public` | Only needed when you run the backend outside Compose. |

PostgreSQL is not published to the host. Uncomment the `ports` mapping in
`docker-compose.yml` if you need direct access.

## Authentication tokens

| Variable | Default | Description |
|---|---|---|
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev placeholders | Signing secrets. Generate with `openssl rand -base64 48`. |
| `JWT_ACCESS_TTL` | `900` | Access-token lifetime in seconds (15 min). |
| `JWT_REFRESH_TTL` | `604800` | Refresh-token lifetime in seconds (7 days). Refresh tokens rotate, and reuse revokes the whole session family. |

## Sign-in providers

| Variable | Default | Description |
|---|---|---|
| `AUTH_PROVIDERS` | `local` | Comma-separated, in priority order: `local` or `local,ldap`. Keep `local` so an admin can always sign in. |
| `LDAP_URL` | `ldap://localhost:389` | Directory server. |
| `LDAP_BIND_DN` / `LDAP_BIND_CREDENTIALS` | | Service account used to search for users. |
| `LDAP_SEARCH_BASE` | | Where users are searched. |
| `LDAP_SEARCH_FILTER` | `(uid={{username}})` | `{{username}}` is replaced with the login name. For AD, e.g. `(sAMAccountName={{username}})`. |
| `LDAP_ATTR_EMAIL` / `LDAP_ATTR_DISPLAY_NAME` | `mail` / `cn` | Attribute mapping. |
| `LDAP_TLS` | `false` | Use LDAPS / StartTLS. |
| `LDAP_ADMIN_GROUP` | empty | Members of this group become admins on sign-in. |

Admins can also change the providers at runtime in the web app under
*Admin → Authentication*. Those settings are stored in the database and override the
environment. To try LDAP with a throwaway directory, run `docker compose --profile ldap up`.

## First admin

| Variable | Default | Description |
|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | `admin@example.com` / `changeme` | Created on startup **only if no users exist**. Changing them later has no effect. |

## Limits

These limits are built in:

| Limit | Value |
|---|---|
| Attachment size | 32 MB per file |
| Request body | 64 MB (attachments are sent base64-encoded) |
| API rate limit | 600 requests per minute per IP |
| Sign-in rate limit | 10 attempts per minute per IP |

## Ports

| Port | Bound to | Purpose |
|---|---|---|
| 8080 | `127.0.0.1` | Caddy: everything (web app, `/api`, `/ws`). Put an HTTPS proxy in front, or switch Caddy to your domain. See [Installation](Installation.md#3-make-it-reachable-https). |
