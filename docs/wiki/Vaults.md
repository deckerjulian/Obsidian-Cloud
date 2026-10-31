# Vaults

A **vault** on the server is a top-level folder that corresponds to one Obsidian vault. You
can have as many as you like: a personal vault, a team vault, one per project.

- A local Obsidian vault syncs with exactly **one** server vault. You choose which one in the
  plugin.
- The web app switches between all vaults you can access (vault switcher, bottom left).
- Each vault is shared independently. Access to one vault says nothing about another.

## Creating a vault

| Where | How |
|---|---|
| Web app | Vault switcher → *new vault*, then enter a name |
| Obsidian | Plugin → *Choose server vault* → *Create new vault*. This uploads the local vault under the name you choose (default: the local vault's name). |
| Command line | `import-vault` (below): best for large existing vaults |

Any signed-in user can create vaults and becomes the **owner** of the vaults they create.
Admins can see and manage all vaults.

## Sharing a vault

Share the whole vault from the vault switcher (or the share icon in the file explorer
header). That grant applies to everything inside unless a deeper grant overrides it. You can
also share single folders or notes. See [Permissions and Sharing](Permissions-and-Sharing.md).

## Renaming and deleting

Both are in the vault switcher. Vault names are encrypted like every other name. Deleting a
vault removes all its notes, attachments and keys from the server for everyone. Obsidian
clients connected to it keep their local files untouched; they stop syncing and report that
the vault is no longer available, so you can choose another one. Vaults cannot be moved into
other folders.

## What's inside a vault on the server

- Your notes (`.md`), stored as encrypted collaborative documents.
- Attachments (images, PDFs, …), stored as encrypted files of up to 32 MB.
- A `.obsidian` **config folder** with the community plugins, their settings, themes and CSS
  snippets that the desktop uploads. The web app uses it to look and work like your desktop.
  Only admins and plugin admins can change it; see
  [Plugins and Vault Config](Plugins-and-Vault-Config.md). Device-specific files such as
  `workspace.json` are never uploaded.

## Importing an existing vault

For a large existing vault, the command-line importer is faster and safer than a first sync:
it only **reads** the local folder and never writes to it.

```bash
pnpm install && pnpm --filter @oc/shared build

node packages/cli/import-vault.mjs \
  --server https://notes.example.com \
  --email you@example.com --password '…' \
  --passphrase '<your encryption passphrase>' \
  --dir "/path/to/My Vault"
```

| Option | Description |
|---|---|
| `--server`, `--email`, `--password` | Your server and account |
| `--passphrase` | Your encryption passphrase. If the account has no keys yet, they are created with it. |
| `--dir` | The local vault folder |
| `--vault-name` | Name of the new server vault (default: the folder name) |
| `--state` | Progress file (default: `./import-state-<vault>.json`). Re-running with the same file resumes the import into the same vault. |
| `--concurrency` | Parallel uploads (default 4) |
| `--dry-run` | Only list what would be imported |

The importer:

- creates the vault and encrypts every name, note and attachment on your machine, keyed for
  you and all admins;
- keeps each note's modification time, so "recently edited" views stay correct;
- includes the `.obsidian` config (plugins and their settings, themes, snippets), but only if
  you are an admin or plugin admin;
- is **resumable**: re-run the same command after an interruption, and finished files are
  skipped;
- retries automatically when the server rate-limits it.

Afterwards, compare the server with the local folder byte for byte:

```bash
node packages/cli/verify-vault.mjs --server … --email … --password … \
  --passphrase … --dir "/path/to/My Vault"
```

Then connect Obsidian to the imported vault (*Choose server vault*). Its first sync is a pure
merge, and identical files are matched without any transfer.

## Content outside vaults

Servers that predate vaults kept notes directly at the top level. That content stays
available: admins see it in the web app under *server tree (without vault)*, and an existing
plugin installation keeps syncing it as *Shared root (legacy)* until you switch it to a vault.
