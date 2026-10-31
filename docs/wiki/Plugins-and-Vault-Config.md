# Plugins and Vault Config

Your vault's community plugins run in the web app too, unmodified. Dataview tables and
`dataviewjs` scripts, Templater, Linter and others work in the browser the way they do in
Obsidian.

## How plugins get to the web app

1. The Obsidian plugin uploads the vault's config from your desktop into the server vault's
   `.obsidian` folder. This happens automatically on every sync, and only changed files are
   uploaded. It includes:
   - `community-plugins.json`, the list of enabled plugins;
   - `plugins/<id>/main.js`, `manifest.json`, `styles.css` and `data.json` (the plugin's
     settings) of every installed plugin except Obsidian Cloud itself;
   - core config such as `app.json`, `appearance.json` and `bookmarks.json`;
   - `themes/` and `snippets/`.

   Per-device layouts (`workspace*.json`) are never uploaded. The upload is **one-way**: the
   desktop is the source of truth, and nothing is downloaded back or deleted.
2. When you open the vault in the web app, it loads exactly the enabled plugins from that
   folder, on top of a compatibility layer for the Obsidian API.
3. The first time per browser (and again whenever a plugin's code changes), you are asked
   whether to **trust and enable** the vault's plugins. Plugins run with full access to the
   decrypted notes in that browser tab, exactly as in Obsidian. If you choose
   *Restricted mode*, the vault works without plugins.

Under *Settings → Community plugins* in the web app you can see which plugins are active, open
each plugin's own settings tab, and reset the trust decision.

## Who may change plugins in the cloud

Plugin code in a vault runs in the browser of **everyone** who opens that vault. That's why
the server protects each vault's `.obsidian` folder:

| Role | Inside `.obsidian` on the server |
|---|---|
| **Admin** | Full access |
| **Plugin admin** | Full access (create, overwrite, rename, move, delete) in the vaults they can write to |
| Everyone else, including vault owners | Read only |

What this means in practice:

- Your desktop uploads plugins only if you are an admin or plugin admin. For other users, the
  plugin's settings tab says *Managed by plugin admins* and nothing is uploaded.
- In the web app, plugin settings changed by users without the role are not saved to the
  server.
- Admins grant and revoke the role in *Admin → Users*, column **Plugins in the cloud**. See
  [Administration](Administration.md).

The web app loads plugin code **only** from the protected folder. A `.obsidian` folder created
before this protection existed is put under protection automatically the first time an admin
or plugin admin opens the vault in the web app or syncs it from Obsidian. Until then, its
settings (appearance, line length) are used, but no plugin code runs.

## What works and what doesn't

Most plugins that render Markdown, add commands, views, settings tabs, editor extensions or
status-bar items work. Known limits of running in a browser:

| Limitation | Effect |
|---|---|
| No Node.js / Electron APIs | Features that call system commands (e.g. Templater's *system command* functions) or read the file system directly don't work. |
| CORS | Plugins that fetch other websites can only reach sites that allow cross-origin requests. |
| Mobile-only or desktop-only plugins | Behave as on Obsidian for the web platform; some simply don't load. |
| Plugin settings | Saved to the server only for admins and plugin admins (see above). |

If a plugin fails to load, it is listed with its error under *Settings → Community plugins*,
and the rest of the vault keeps working.

## Dataview tips

- `dataviewjs` scripts can use the globals `app`, `dv` and `moment`, as in Obsidian.
- Dates such as `file.mtime` reflect when the note was last edited, including edits imported
  with the CLI importer.
- In Live Preview, Dataview blocks render like in Obsidian. Click the block (or its `</>`
  button) to edit the query.
