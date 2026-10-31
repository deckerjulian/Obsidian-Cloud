# Permissions and Sharing

Access is granted as **capabilities** on a vault, folder or note, and inherited by everything
below it. The most specific grant (the deepest one) wins.

| Capability | Allows |
|---|---|
| read | See the item, open and download it |
| create | Create files and folders inside a folder |
| edit | Change content, rename |
| delete | Delete the item and everything below it |
| share | Grant or revoke access for others |

Presets bundle these: **viewer** = read; **editor** = read, create, edit; **owner** =
everything.

## Sharing

In the web app, open the share dialog:

- for a **vault**: vault switcher → *share vault*;
- for a **folder or note**: right-click it in the file explorer → *share*.

Pick a person, choose a preset or individual capabilities, and grant access. Two things happen
at once:

1. The server records the permission.
2. Your browser **re-encrypts the keys** of every note in that subtree for the recipient. The
   dialog reports how many keys were shared. This is why your encryption must be unlocked when
   you share.

The dialog shows the recipient's key fingerprint. The first time you share with someone,
their key is trusted and pinned. If it ever changes, sharing is blocked until you verify and
trust it again. This protects against a server substituting its own key.

## Good to know

- **The recipient must have signed in once** and set up encryption, so a key exists for them.
- **New notes are keyed automatically.** A note created inside a folder that others can
  already access is encrypted for them right away, from the web app and from Obsidian. Notes
  that existed before a grant are covered by the share itself.
- **Revoking** (*Remove* in the same dialog) deletes the permission and the person's keys for
  that subtree. As with any end-to-end encrypted system, content they already saw must be
  assumed known to them.
- **Read-only in Obsidian:** without *edit* you can open a note, but typing is blocked. Changes
  made by other programs are reverted on the next sync. If your access is revoked while a note
  is open, it becomes read-only within one sync interval.
- **Admins can read everything.** Every document key is also encrypted for every admin. See
  [Administration](Administration.md#admins-can-read-everything).
- **Vault config (`.obsidian`)** has an extra rule: only admins and plugin admins may change it,
  whatever the vault permissions say. See [Plugins and Vault Config](Plugins-and-Vault-Config.md).
