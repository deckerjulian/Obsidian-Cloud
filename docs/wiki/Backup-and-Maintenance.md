# Backup and Maintenance

## What to back up

| What | Why |
|---|---|
| The PostgreSQL database (`pgdata` volume) | Everything: users, encrypted notes, attachments, keys, permissions |
| `.env` | Your secrets and configuration |
| Optional: Caddy's `caddydata` volume | TLS certificates (re-issued automatically if lost) |

Back up the database with `pg_dump` while it runs:

```bash
docker compose exec -T postgres pg_dump -U obsidian -Fc obsidian_cloud \
  > obsidian-cloud-$(date +%F).dump
```

Restore into an empty database:

```bash
docker compose exec -T postgres pg_restore -U obsidian -d obsidian_cloud --clean --if-exists \
  < obsidian-cloud-2026-10-31.dump
```

> Backups contain only ciphertext. They are safe to store elsewhere, but they **cannot** help
> anyone who has lost their encryption passphrase.

Automate the dump with cron or a systemd timer, keep several generations, and copy them off
the host.

## Updating the server

```bash
git pull
docker compose up -d --build
```

The backend applies new database migrations on start. Take a backup first if the update
contains migrations (`packages/backend/prisma/migrations/`).

## Updating the Obsidian plugin

```bash
pnpm install
pnpm --filter @oc/plugin build
cp packages/plugin/main.js packages/plugin/manifest.json \
   "<your vault>/.obsidian/plugins/obsidian-cloud/"
```

Then restart Obsidian. If the vault syncs between devices via iCloud or Dropbox, the update
reaches your other devices automatically.

## Health and logs

```bash
docker compose ps                    # backend shows (healthy)
docker compose logs -f backend       # API, relay and migration logs
curl -s http://127.0.0.1:8080/api/health
```

## Resetting a test installation

```bash
docker compose down -v               # deletes ALL data: users, keys, notes
docker compose up -d --build
```
