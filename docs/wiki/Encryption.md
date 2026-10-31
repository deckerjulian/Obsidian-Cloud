# Encryption

Obsidian Cloud is **zero-knowledge towards the server**. Note content, file and folder names,
and attachments are encrypted on your devices before they are uploaded. The server stores and
forwards ciphertext, enforces permissions on an id-based tree, and can never read what your
notes are called or what they contain.

You have two secrets:

| Secret | Used for | The server sees it? |
|---|---|---|
| Login password | Signing in (local account or LDAP) | Yes, during sign-in |
| **Encryption passphrase** | Unlocking your personal key pair on a device | **Never** |

That's why they must be different. Keep the passphrase in a password manager: there is no
server-side recovery.

Everything below happens client-side (in the browser or the Obsidian plugin)
with the Web Crypto API. The shared implementation lives in
[`packages/shared/src/crypto.ts`](../../packages/shared/src/crypto.ts). The server
never imports this module; it only stores and forwards the opaque base64 strings
the clients produce.

## The key hierarchy

There are three layers of keys. Only the bottom layer touches actual data.

```
  E2EE passphrase  (never leaves the device, never sent to the server)
        |  PBKDF2-SHA256, 600,000 iterations, 16-byte random salt
        v
  Wrapping key  (AES-256-GCM, derived on the fly, never stored anywhere)
        |  AES-GCM-wraps...
        v
  User key pair  (RSA-OAEP 2048, SHA-256 — one per user)
        |  RSA-wraps, one copy per authorised user...
        v
  Document content key  (AES-256-GCM — one random key per document)
        |  AES-GCM-encrypts...
        v
  note content (Yjs updates) / file and folder name / binary attachment
```

- The user key pair is created once, on first encryption setup. The private key
  is exported (PKCS8) and AES-GCM-encrypted with the wrapping key; only the
  ciphertext, the public key (SPKI), and the PBKDF2 salt are uploaded
  (`POST /api/e2ee/keys`, `user_keys` table). The server can verify none of it.
- The content key: every node (note, folder, attachment) gets its own random
  AES-256-GCM key when it is created. The creator wraps it with their own RSA
  public key and stores the wrapped copy server-side
  (`PUT /api/e2ee/document-keys/:docId`, `document_keys` table, one row per
  `(docId, userId)`), and also wraps it for anyone who already has access to the
  parent folder and for all admins (see [Sharing and revoking](#sharing-and-revoking)).
- Every content AES-GCM ciphertext is a versioned envelope
  `[0x01][12-byte IV][ciphertext+tag]`, with the ciphertext's **purpose**
  (`name` / `blob` / `yupdate` / `awareness`) bound as AES-GCM additional
  authenticated data. Under one content key a name, a blob and a Yjs update are
  therefore not interchangeable — the relay can't re-type or swap one for
  another without failing authentication. Legacy ciphertext written before this
  envelope (bare `[IV][ciphertext]`, no purpose) is still read via a fallback,
  so no migration is needed.

## Setup, unlock, and device persistence

- Setup (first time): generate the RSA pair, derive the wrapping key from the
  passphrase, and upload `{publicKey, encryptedPrivateKey, kdfSalt}`. The
  passphrase itself is never transmitted — deliberately separate from the login
  password, which the server does see during authentication.
- Unlock (new device or after lock): fetch the wrapped key material
  (`GET /api/e2ee/keys/me`), re-derive the wrapping key from the entered
  passphrase, and unwrap the private key locally. A wrong passphrase simply
  fails the AES-GCM authentication check — the server is not involved.
- Persistence: the unlocked key pair is cached in IndexedDB as non-extractable
  `CryptoKey` objects, so relaunching Obsidian or reloading the web app doesn't
  re-prompt for the passphrase. Lock or sign out clears it. Unwrapped content
  keys are additionally cached in memory per session, and the plugin bulk-fetches
  all wrapped keys in one request (`GET /api/e2ee/document-keys`) before a sync
  run to avoid N+1 requests.

## What the server stores, and what it can read

The server sees structure but not names or content:

- Tree structure — node ids, parent links, id-based paths, kind, depth: visible
  (structure only).
- File and folder names: AES-GCM ciphertext.
- Note content: a log of AES-GCM-encrypted Yjs updates (`doc_updates`).
- Binary attachments: AES-GCM ciphertext blobs, plus a sha256 of the ciphertext.
- User keys: public key, plus passphrase-wrapped private key and salt.
- Document keys: RSA-wrapped copies, one per authorised user.
- ACL (who may read, edit, or share which subtree): visible, enforced
  server-side.

Because names are ciphertext, the server can't build name-based paths. The
materialized path of every node is an id-chain (`<uuid>/<uuid>/...`), so the
server can enforce subtree permissions without learning a single name. Clients
rebuild the human-readable tree by decrypting each name along the parent chain
with the respective document key.

The server is therefore structure-aware but content-blind: it knows that you
have 240 nodes, how they nest, and who may access which subtree, but it can
never know what any of them are called or contain.

## Real-time collaboration on ciphertext

Live editing uses Yjs (CRDT), but the WebSocket relay (`/ws/doc/:docId`) is
zero-knowledge — see
[`packages/shared/src/yjs-provider.ts`](../../packages/shared/src/yjs-provider.ts):

1. A client edits the note, and Yjs produces a binary update.
2. The `EncryptedProvider` AES-GCM-encrypts the update with the document's
   content key and sends it as an opaque frame.
3. The relay checks the sender's JWT and ACL (edit capability for writes, read
   for connecting), appends the ciphertext to the document's update log, and
   forwards it to every other connected client.
4. Receiving clients decrypt and call `Y.applyUpdate()`. CRDT semantics merge
   concurrent edits without a central authority ever seeing plaintext.

Awareness messages (live cursors, names, and colors of collaborators) travel
over the same channel and are encrypted the same way.

Compaction: the update log would grow forever, so after a threshold of appended
updates a writable client periodically replaces the whole log with one snapshot
update (a `T_REPLACE` frame), computed and encrypted client-side, so compaction
is zero-knowledge too. Read-only connections may not compact.

Offline edits merge through the same mechanism. Each client persists its Yjs
state locally (IndexedDB), and on reconnect the server replays the encrypted
update log; a three-way seed decision (last-synced state, local file, server
state) decides whether to pull, push, or ask the user to resolve a conflict.

## Sharing and revoking

Granting someone access to a subtree does two things:

1. ACL entry (server-enforced): the recipient gets capabilities (read, create,
   edit, delete, share) on the node, inherited by the subtree.
2. Key sharing (client-side): the granter unwraps the content key of every
   document in the subtree with their private key and re-wraps each one with the
   recipient's RSA public key (`GET /api/e2ee/public-keys` provides the public
   keys). The wrapped copies are uploaded, and the recipient can now decrypt
   names and content. The recipient's public key is trusted-on-first-use and
   pinned locally; a later change blocks sharing until you re-verify it, so a
   malicious server cannot silently substitute its own key to intercept a share.

Both steps happen together in the web Share dialog. Some consequences of the
design:

- A user must have set up encryption once, so a public key exists, before
  anything can be shared with them.
- Ongoing keying is automatic. A note created inside an already-shared folder is
  keyed for the folder's existing grantees at creation (the server returns the
  co-grantees' public keys via `GET /api/e2ee/grantees/:docId`), so new content
  doesn't need a manual re-share. Adding keys for a user is allowed without the
  `share` capability when that user is already entitled to read the subtree.
- Admins are implicit readers of every document: each content key is wrapped
  for all admins (new docs at creation; existing docs when a key-holder next
  syncs — the client re-keys its own documents for the admin set via
  `GET /api/e2ee/admin-keys`). Admins therefore read all content — a deliberate
  relaxation of the zero-knowledge model in exchange for full administrative
  access.
- Revoking removes the ACL entry and deletes the recipient's wrapped key copies
  (the server refuses to delete the last key for a document, and won't strip
  keys the user still holds through a separate deeper grant). The usual E2EE
  caveat applies: revocation prevents future access, but content the recipient
  already decrypted while authorised must be assumed known to them (the content
  keys are not rotated on revoke).

## Trust model and limitations

- Protected against: a curious or compromised server or hosting provider,
  database leaks, and any network observer. All of them only ever see ciphertext,
  wrapped keys, and structural metadata.
- Not protected against: a compromised client (malware on a device with an
  unlocked vault), weak passphrases (PBKDF2 slows brute force by roughly 600k
  times, but it doesn't fix `hunter2`), or a malicious build of the web app
  served by a compromised host — self-hosting the web client is part of the
  trust assumption.
- Metadata is visible by design: node count, tree shape, sizes, timestamps, and
  who shares with whom. Names, content, and attachments are not.
- Recovery is limited and never server-side. Your passphrase wraps your private
  key; lose it on every device at once and you lose access to your own key pair.
  Documents that another key-holder still has (an admin — who holds keys to
  everything — or another grantee) can be re-shared back to you once you set up a
  new passphrase; a document that only you ever held a key for is gone for good.
  The server can recover nothing: it has no passphrase and no plaintext.

## Security notes

- Production refuses to start with the default `JWT_*` secrets. Always set strong values and
  change the bootstrap admin password before exposing a deployment.
- Sign-in is rate-limited (10 attempts per minute per IP), and refresh tokens rotate with
  reuse detection.
- Because the server is content-blind, there is no server-side full-text search, name sorting
  or preview. Search happens in your browser after unlocking, and file-name uniqueness is not
  enforced server-side.
- Community plugins run with access to decrypted notes in the browser. Only plugin admins can
  change them, and each browser asks before running them. See
  [Plugins and Vault Config](Plugins-and-Vault-Config.md).
