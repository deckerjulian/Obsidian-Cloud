# Obsidian Plugin

The *Obsidian Cloud* plugin keeps a local Obsidian vault in sync with one vault on your
server. It works on desktop and mobile. Its interface follows Obsidian's language setting
(English or German).

## Installation

The plugin isn't in the community plugin directory. Build it once from the repository:

```bash
pnpm install
pnpm --filter @oc/plugin build        # creates packages/plugin/main.js
```

Copy `main.js` and `manifest.json` into the vault:

```
<your vault>/.obsidian/plugins/obsidian-cloud/
```

In Obsidian, go to *Settings → Community plugins*, turn off restricted mode if needed, and
enable **Obsidian Cloud**.

> **Vaults in iCloud or Dropbox.** The plugin folder syncs to your other devices along with
> the vault. Sign-in and sync state are stored **per device**, so you still sign in once on
> each device.

## Setting up

Open *Settings → Obsidian Cloud*. The **status card** at the top shows the next step and has
a button for it. Until everything is set up, a checklist shows your progress:

1. **Server.** Enter the address, e.g. `https://notes.example.com`. It is checked as you type
   ("Server reachable").
2. **Account.** *Sign in* with your email (or directory username) and password. You can also
   fix the server address in the sign-in dialog.
3. **Encryption.** On your first device you *set up* an encryption passphrase. A strength meter
   helps you choose a good one. On every other device you *unlock* with the same passphrase.
   The unlocked key is stored on the device, so you aren't asked again after a restart.
4. **Server vault.** Choose which vault on the server this vault mirrors:
   - A vault with the same name as your local vault is preselected and marked *same name*.
   - Or choose *Create new vault* to upload this vault as a new one; you can edit the name.
5. **First sync.** The dialog explains what will happen, then shows progress and a summary
   (notes downloaded, folders, files uploaded, problems).

The first sync **only merges**: what is missing locally is downloaded, what is missing on the
server is uploaded, identical files are matched without transfer, and **nothing is deleted** on
either side.

## Everyday use

You don't need to do anything. Edits, new files, renames, moves and deletions sync
automatically. Changes from other devices arrive live while a note is open, and otherwise
within the check interval (20 s by default).

### Status bar

The cloud item in the status bar (bottom right) shows the current state:

| Shows | Meaning |
|---|---|
| ☁ *4 minutes ago* | Up to date, with the last successful sync |
| ⟳ *Syncing…* | A sync is running |
| 🔒 *Locked* | Encryption is locked on this device. Click to unlock. |
| *No vault* / *Set up* | Setup isn't finished |
| *Offline* | The server is unreachable. Changes are kept and synced later. |
| ⚠ *Error* | The last sync failed. Hover for details, or click → *Retry*. |
| *Signed out* | Not signed in |

Click the status bar item (or the cloud ribbon icon) for a menu:

- the current status and the suggested next step
- *Sync now*
- *Open current note in the web app*
- *Change vault…*
- *Show sync log*
- *Settings*
- *Lock encryption on this device*
- *Sign out*

### Commands

All commands are available from the command palette (`Ctrl/⌘ + P`), prefixed with
*Obsidian Cloud:*:

| Command | Does |
|---|---|
| Sign in / out | Opens the sign-in dialog, or signs out |
| Sync now | Runs a full sync immediately (also re-asks deferred conflicts) |
| Set up / unlock encryption | Opens the passphrase dialog |
| Choose server vault | Opens the vault picker |
| Open current note in the web app | Opens the note in your browser |
| Show sync log | Opens the sync log |

## Settings reference

| Section | Setting | Description |
|---|---|---|
| Server & account | Server address | Locked while signed in. Sign out to switch servers, because sync bookkeeping belongs to one server. |
| | Account | *Sign in* / *Sign out*. Signing out also clears this device's sync bookkeeping. |
| Vault | Server vault | The server vault this vault mirrors. *Change vault…* starts a fresh, merge-only first sync. The globe icon opens the vault in the web app. |
| Encryption | Status | *Unlocked on this device*, *Locked* or *Not set up yet*. *Lock encryption on this device* removes the stored key, so the passphrase is needed again. |
| Synchronization | Check for changes | How often the server is polled for changes from other devices (5–120 s). |
| | Ask how to handle sync problems | On: a dialog for conflicts and failures. Off: both versions are kept automatically and problems only go to the log. |
| | Excluded from sync | Files you chose to *Never sync*. Each one can be re-enabled individually. |
| Plugins & appearance | Status | Whether your community plugins, their settings, theme and snippets have been uploaded for the web app. Only admins and plugin admins can upload them; see [Plugins and Vault Config](Plugins-and-Vault-Config.md). |
| Sync log | | Every download, upload and problem with a timestamp. Filter by *All* / *Problems*, copy to the clipboard, or clear. |

## Conflicts and problems

- **Conflict.** If a note was changed both locally and on the server while they were apart,
  you choose:
  - **Keep both (conflict copy)**, the recommended option
  - **Use server version**
  - **Use my version**

  Closing the dialog defers the decision until the next *Sync now*.
- **A file can't be synced.** For example, it is too large (over 32 MB), you lack permission,
  or the server is unreachable. You can *Retry now*, *Decide later*, or *Never sync this file*.
- **Read-only notes.** Without edit permission you can open a note, but typing is blocked with
  a notice. Changes made by other programs are reverted on the next sync.

## Several devices and vaults

- One local vault syncs with **one** server vault. To sync several server vaults, use several
  local vaults, each with its own plugin configuration.
- Each device signs in separately. Sign-in, sync state and the unlocked key never leave the
  device. The vault's `data.json` holds only shared settings such as the server address and
  the chosen vault.

See [Sync Behavior](Sync-Behavior.md) for details of how syncing decides what to do.
