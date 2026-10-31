# Web App

Open your server's URL in any modern browser. The web app is an Obsidian-like workspace for
the vaults you have access to. Notes are decrypted in the browser, and the server never sees
them.

> Language: the vault workspace is currently in German; the admin area is in English.

## Signing in

1. Sign in with your email (or directory username) and password.
2. Unlock encryption with your **encryption passphrase**. On your very first sign-in you set
   one up. The unlocked key stays in this browser until you lock it (account dialog) or sign
   out.
3. If the vault contains community plugins, you are asked once per browser whether to
   **trust and enable** them. See [Plugins and Vault Config](Plugins-and-Vault-Config.md).

## Layout

| Area | What's there |
|---|---|
| Ribbon (far left) | Files, search, bookmarks, quick switcher, command palette, plugin ribbon icons, community plugins, settings |
| Left sidebar | File explorer with a context menu (new note/folder, rename, delete, share), search, bookmarks. At the bottom: the **vault switcher** and account button. |
| Center | Tabs. Each tab shows a note in reading or editing view, or a file viewer (images, PDF, audio/video, HTML). |
| Right sidebar | Outline (headings; click to jump) and backlinks |
| Status bar | Plugin status items, indexing state, word count |

On phones the sidebars become overlays: only one is open at a time, and tapping the note
closes it.

## Reading and editing

Every note can be shown in three ways, like in Obsidian:

| Mode | Description | Switch |
|---|---|---|
| **Reading view** | Fully rendered: wikilinks, embeds, callouts, tables, Mermaid, math, properties, plugin blocks such as Dataview | `⌘/Ctrl + E` toggles reading ↔ editing |
| **Live Preview** (default editing mode) | You edit Markdown, but everything outside the cursor is shown rendered. Markers like `#`, `**` or `[[` are hidden, links are clickable, tasks are checkboxes. Tables, callouts, code blocks, math, front matter and Dataview blocks are rendered as blocks; click one (or its `</>` button) to edit its source. | ⋮ menu → *Source mode* / *Live Preview*, or command palette |
| **Source mode** | Plain Markdown with syntax highlighting | same as above |

Edits are saved continuously and merge in real time with other people and devices (CRDT).
Collaborators' cursors are shown with their names. A formatting toolbar sits above the
editor.

### Readable line length

By default the vault's own `.obsidian/app.json` decides whether text is limited to a readable
width (about 750 px) or uses the full window width, the same as on your desktop. To change it
in the browser:

- ⋮ menu (top right of a note) → *Full window width* / *Readable line length*, or
- *Settings → Editor → Readable line length*.

### Editor settings

Open *Settings* with `⌘/Ctrl + ,` or the gear icon in the ribbon. The **Editor** tab has:

| Setting | Default |
|---|---|
| Default view for new tabs: editing or reading | from the vault (`defaultViewMode`); Obsidian's default is editing |
| Default editing mode: Live Preview or source mode | from the vault (`livePreview`) |
| Readable line length | from the vault (`readableLineLength`) |
| Show line numbers | from the vault (`showLineNumber`) |

Changes apply to this browser only and never change your desktop. *Reset to vault settings*
removes them.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘/Ctrl + O` | Quick switcher (open a file; type a new name to create it) |
| `⌘/Ctrl + P` | Command palette (built-in and plugin commands) |
| `⌘/Ctrl + E` | Toggle reading / editing |
| `⌘/Ctrl + ,` | Settings |
| `⌘/Ctrl + Shift + F` | Search the vault |
| `⌘/Ctrl + Alt + N` | New note |
| `⌘/Ctrl + Alt + ←` / `→` | Back / forward |
| `⌘/Ctrl + Alt + W` | Close tab |
| `⌘/Ctrl + S` | Runs Obsidian's *save* command (notes save automatically; plugins such as Linter hook into it) |
| `⌘/Ctrl + click` on a link | Open in a new tab |

## Search

The search panel searches note names and content. It understands these filters:

| Query | Finds |
|---|---|
| `epilepsy therapy` | Notes containing all words |
| `"status epilepticus"` | Notes containing the exact phrase |
| `tag:#neuro` | Notes with the tag |
| `path:Skripte/` | Notes whose path contains the text |
| `file:week` | Notes whose file name contains the text |

Clicking a tag in a note opens the search with that tag.

## Vaults

The **vault switcher** at the bottom of the left sidebar lists your vaults. From there you can
create, rename, share or delete vaults. Admins also reach *user management* and the raw
*server tree* (content outside any vault) here. See [Vaults](Vaults.md).

## Appearance

The vault's `.obsidian/appearance.json` is applied, as on the desktop: light or dark base
theme, fonts and font size, accent color, the selected community theme, and enabled CSS
snippets. In the account dialog you can override light or dark for this browser.

## Linking to a note

The address bar always shows the open note (`#/vault/<id>/<path>`). Copy it to link someone
with access straight to the note. From Obsidian, *Open current note in the web app* does the
same.
