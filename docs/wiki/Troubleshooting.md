# Troubleshooting

First steps for almost any problem:

1. Look at the plugin's status bar item and the status card in its settings. They name the
   problem and offer the next step.
2. Open the **sync log** (*Show sync log*) and filter on *Problems*.
3. Run *Sync now*.

## Obsidian plugin

| Message or symptom | Cause and fix |
|---|---|
| *Server not reachable — check the address and your connection* | Wrong URL, missing `https://`, server down, or a proxy that doesn't forward `/api`. Fix the address in the sign-in dialog or settings. |
| *The server answered with HTTP 404 / 502…* | The address points to a different service, or the reverse proxy isn't routing to Obsidian Cloud. See [Installation](Installation.md#3-make-it-reachable-https). |
| Status shows *Offline* | The server can't be reached right now. Changes are kept and synced when it's back; nothing to do. |
| Status shows *Locked* | Encryption isn't unlocked on this device. Click → *Unlock* and enter your passphrase. |
| *Wrong passphrase* | It's the **encryption passphrase**, not the login password. |
| *No server vault chosen* | Choose one: status menu → *Choose vault…* |
| *The server vault “…” is not available* | It was deleted or is no longer shared with you. Nothing changed locally; choose another vault. |
| *N server item(s) skipped — names could not be decrypted* | You don't have keys for those items yet (not shared with you), or encryption is locked. Deletions and uploads pause until this is resolved. Ask the owner to share again while their encryption is unlocked. |
| *“…” is read-only* | You lack *edit* on that note. Ask someone with *share* to grant it. |
| *No encryption key for “…” (not shared with you yet)* | You can see the note but got no key. The person sharing must share again with encryption unlocked. |
| Plugins and appearance say *Managed by plugin admins* | Only admins and plugin admins can upload a vault's plugins. Ask an admin for the role if you should manage them. |
| A file never syncs | It may be over 32 MB, or you chose *Never sync this file*. Check *Excluded from sync* in the settings. |
| Changes don't show up on another device | Both devices must be signed in, unlocked and connected to the **same** server vault. Run *Sync now* on both and compare their sync logs. |

## Web app

| Symptom | Cause and fix |
|---|---|
| A note opens empty | Encryption is locked in this browser, or the note wasn't shared with you. Unlock via the account dialog. |
| Plugins don't run | You chose *Restricted mode*, or the vault's `.obsidian` isn't protected yet (an admin or plugin admin must open the vault once). Reset the trust decision under *Settings → Community plugins*. |
| A plugin shows an error | See *Settings → Community plugins*. Plugins that need Node.js/Electron or fetch other sites (CORS) are limited in browsers. See [Plugins and Vault Config](Plugins-and-Vault-Config.md#what-works-and-what-doesnt). |
| Text is narrow / too wide | ⋮ menu → *Readable line length* / *Full window width* |
| `(unnamed)` item in the server tree | A node whose name can't be decrypted (old client bug). Admins can delete it there. |

## Server

| Symptom | Cause and fix |
|---|---|
| Backend won't start in production | Default `JWT_*` secrets. Set strong values in `.env`. |
| Bootstrap admin can't sign in | The bootstrap account is only created while no users exist. Use an existing admin, or reset the password from *Admin → Users*. |
| `429 Too Many Requests` | Rate limit (600 requests/min per IP; sign-in 10/min). Behind a proxy, set `TRUST_PROXY=true` so users don't share one IP. |
| Live editing doesn't connect | The reverse proxy must forward WebSockets on `/ws`. See the nginx example in [Installation](Installation.md#option-a-an-existing-reverse-proxy-nginx-apache-traefik). |
| Large attachments fail | Raise the proxy's body limit (e.g. nginx `client_max_body_size 64m`). The server accepts up to 32 MB per file. |

Still stuck? Copy the sync log (copy button in the log) and the output of
`docker compose logs backend --since 10m` when you report the problem.
