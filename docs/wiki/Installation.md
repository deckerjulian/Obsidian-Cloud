# Installation

This page sets up a server from scratch. You need a Linux host (or any machine with Docker),
Docker Engine with the Compose plugin, and ideally a domain name.

## 1. Get the code and configure

```bash
git clone https://github.com/deckerjulian/Obsidian-Cloud.git obsidian-cloud
cd obsidian-cloud
cp .env.example .env
```

Edit `.env`. For anything beyond a local test, set at least:

| Variable | What to set |
|---|---|
| `PUBLIC_URL` | The URL people will open, e.g. `https://notes.example.com` |
| `NODE_ENV` | `production` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Two different random values: `openssl rand -base64 48` |
| `POSTGRES_PASSWORD` | A strong database password |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first admin account (created only while no users exist) |
| `TRUST_PROXY` | `true` when another reverse proxy sits in front (see below) |

In production the backend refuses to start with the default JWT secrets. All variables are
described in [Configuration](Configuration.md).

## 2. Start

```bash
docker compose up -d --build
docker compose ps          # backend should become "healthy"
```

This starts four containers:

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 16. All data lives in the `pgdata` volume. |
| `backend` | NestJS REST API under `/api` and the encrypted Yjs relay under `/ws/doc`. Applies database migrations on every start. |
| `web` | The built web app (static files). |
| `caddy` | Reverse proxy: the single entry point that routes `/api`, `/ws` and the web app. |

Caddy listens on `127.0.0.1:8080`, which is the **loopback interface only**. Open
<http://localhost:8080> on the server itself to check that it works.

## 3. Make it reachable (HTTPS)

Use one of these two options.

### Option A: an existing reverse proxy (nginx, Apache, Traefik…)

If the host already runs a web server on ports 80/443, proxy your domain to
`http://127.0.0.1:8080` and let that server handle TLS. WebSockets must be forwarded. With
nginx:

```nginx
server {
    server_name notes.example.com;
    listen 443 ssl http2;
    # ssl_certificate … / ssl_certificate_key …

    client_max_body_size 64m;          # attachments up to 32 MB, base64-encoded

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;      # keep live-editing sockets open
    }
}
```

Set `TRUST_PROXY=true` in `.env` so rate limiting uses the real client IP, then run
`docker compose up -d`.

### Option B: Caddy handles HTTPS directly

If nothing else uses ports 80 and 443:

1. In `Caddyfile`, replace `:8080` with your domain, e.g. `notes.example.com {`.
2. In `docker-compose.yml`, publish ports `80:80` and `443:443` for the `caddy` service. The
   lines are already there as comments.
3. Run `docker compose up -d`. Caddy obtains and renews a Let's Encrypt certificate.

> If you use Cloudflare or another CDN in front, make sure WebSockets are enabled for the
> domain.

## 4. First sign-in (admin)

1. Open your URL and sign in with the bootstrap admin from `.env`.
2. You are asked to **set up end-to-end encryption**. Choose an encryption passphrase that is
   *different* from your login password and store it in a password manager. Without it your
   data cannot be decrypted, not even by the server.
3. Change the admin password: account dialog (bottom left) → *Change password*.
4. Create accounts for other people under *Admin → Users*, or connect LDAP / Active Directory
   (see [Administration](Administration.md)).
5. Create your first vault in the web app, or import an existing one (see [Vaults](Vaults.md)).

## 5. Connect Obsidian

Build the plugin and install it into your vault as described in
[Obsidian Plugin](Obsidian-Plugin.md#installation).

## Updating later

```bash
git pull
docker compose up -d --build
```

Migrations run automatically. Back up the database before larger updates; see
[Backup and Maintenance](Backup-and-Maintenance.md).
