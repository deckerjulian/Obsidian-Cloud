# Sync Behavior

This page explains what the Obsidian plugin does when it syncs, and why it never loses data
by accident.

## Two channels

| Channel | What travels | When |
|---|---|---|
| **Structure sync** | Which files and folders exist, their names, attachments, deletions, renames | Live on local changes, plus a background check every 20 s (configurable 5–120 s). Idle checks are almost free thanks to ETag/304. |
| **Live documents** | Note content as encrypted Yjs (CRDT) updates | While a note is open: in real time, with other people's cursors. Up to 12 sessions stay open; the least recently used ones close automatically. |

The web app uses the same live channel for open notes and refreshes its file tree about every
10 seconds (paused while the tab is hidden).

## The first sync is a merge

The first sync after choosing a vault, and after switching vaults:

- downloads everything you can access that is missing locally;
- uploads local files that are missing on the server (if you may create there);
- matches identical paths without transferring anything;
- **deletes nothing** on either side. A file that exists only on one side is copied, never
  treated as deleted.

So a new, empty device can never wipe the server, and connecting a full vault never wipes
local files.

## After that

- **Local deletion** → deleted on the server.
- **Server deletion** → the local file moves to Obsidian's trash.
- **Rename or move** → mirrored as a rename, so links and backlinks survive.
- **Deleted while Obsidian was closed** → propagated on the next start. If *none* of the
  previously synced files are present (for example a restored or reset vault), the plugin
  pulls instead of deleting.
- **Offline edits** are kept locally (IndexedDB) and merged when the connection returns.

## Safety rules

- **Deletions pause** whenever any server item's name can't be decrypted, for example because
  encryption is locked or a key wasn't shared yet. A missing key must never look like a
  deletion.
- **A vanished vault** (deleted or unshared) stops syncing with a message. Nothing local is
  changed.
- **Read-only items** can't be modified locally. Typing is blocked, and other changes are
  reverted to the server state.
- **Signing out** clears this device's sync bookkeeping, so signing in with a different account
  starts with a safe merge again.

## Conflicts

When a note was changed on both sides while they were apart, a three-way comparison (last
synced state, local file, server state) decides:

- only one side changed → that change wins, no question asked;
- both changed → you choose *Keep both (conflict copy)*, *Use server version* or
  *Use my version*. With *Ask how to handle sync problems* turned off, both are kept
  automatically.

While a note is open, concurrent edits never conflict: the CRDT merges them character by
character.

## The sync log

*Settings → Obsidian Cloud → Sync log*, or *Show sync log* from the menu, lists every
download (↓), upload (↑), removal (✗), rename (↔) and problem with a timestamp. Filter on
*Problems*, or copy the log when asking for help.
