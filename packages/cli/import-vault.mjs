#!/usr/bin/env node
/**
 * One-shot, end-to-end-encrypted import of a local Obsidian vault into
 * Obsidian Cloud as a new (or resumed) vault.
 *
 * The local vault is only READ — nothing is written into it. Everything is
 * encrypted here, exactly like the Obsidian plugin / web app do it: a fresh
 * AES-256-GCM content key per node (name + content), wrapped for the importing
 * user and every admin. Notes become a Yjs document (one encrypted update),
 * attachments an encrypted blob. The vault's `.obsidian` config (plugins incl.
 * their settings, themes, snippets, core config) goes into a `.obsidian`
 * folder inside the vault, so the web app can run the same plugins.
 *
 * Resumable: progress is recorded in a state file (relative path → node), so
 * a re-run after an interruption skips what is already on the server.
 *
 *   node import-vault.mjs --server https://vault.example.com \
 *     --email me@example.com --password '…' --passphrase '…' \
 *     --dir "/path/to/Vault" [--vault-name "Vault"] [--state ./import-state.json]
 *
 * If the account has no E2EE keys yet, they are created with --passphrase.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
// @oc/shared's ESM build uses bundler-style (extensionless) imports; plain
// Node loads its CommonJS build instead. One yjs copy is resolved for both.
const require = createRequire(import.meta.url);
const Y = require('yjs');
const e2 = require('@oc/shared/crypto');
const { isTextFileName, MAX_BLOB_BYTES, YTEXT_FIELD } = require('@oc/shared');

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    passphrase: { type: 'string' },
    dir: { type: 'string' },
    'vault-name': { type: 'string' },
    state: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    'dry-run': { type: 'boolean', default: false },
  },
});
for (const k of ['server', 'email', 'password', 'passphrase', 'dir']) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}
const SERVER = args.server.replace(/\/+$/, '');
const API = `${SERVER}/api`;
const DIR = args.dir.replace(/\/+$/, '');
const VAULT_NAME = args['vault-name'] ?? basename(DIR);
const STATE_FILE = args.state ?? `./import-state-${VAULT_NAME.replace(/[^\w.-]+/g, '_')}.json`;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 4);

// ── which files to import ────────────────────────────────────────────────────
/** Obsidian ignores dot-files/-folders; so do we (except the config dir). */
const isHidden = (name) => name.startsWith('.');
/** Config files worth carrying over (device-specific workspace state is not). */
function wantConfigFile(rel) {
  // rel is relative to .obsidian/
  const parts = rel.split('/');
  if (parts.some((p) => p === '.DS_Store')) return false;
  if (parts.length === 1) return /\.json$/i.test(rel) && !/^workspace/i.test(rel);
  if (parts[0] === 'plugins') {
    // The sync plugin's own data.json holds this device's credentials.
    if (parts[1] === 'obsidian-cloud') return false;
    return parts.length === 3 && ['main.js', 'manifest.json', 'styles.css', 'data.json'].includes(parts[2]);
  }
  return parts[0] === 'themes' || parts[0] === 'snippets';
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf',
  epub: 'application/epub+zip', html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  css: 'text/css', js: 'text/javascript', json: 'application/json', txt: 'text/plain',
  canvas: 'application/json', base: 'text/yaml', mp3: 'audio/mpeg', mp4: 'video/mp4',
  wav: 'audio/wav', m4a: 'audio/mp4', webm: 'video/webm', ogg: 'audio/ogg', csv: 'text/csv',
  py: 'text/x-python', xml: 'application/xml', opf: 'application/oebps-package+xml',
  ncx: 'application/x-dtbncx+xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
const mimeOf = (name) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Walk the vault: folders before their children, stable order. */
async function walk(absDir, relDir, out, inConfig) {
  const entries = (await readdir(absDir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const abs = join(absDir, e.name);
    if (!relDir && e.name === '.obsidian' && e.isDirectory()) {
      out.push({ rel, kind: 'folder' });
      await walk(abs, rel, out, true);
      continue;
    }
    if (isHidden(e.name) || e.name.endsWith('.icloud')) continue;
    if (e.isDirectory()) {
      if (inConfig) {
        const cfgRel = rel.slice('.obsidian/'.length);
        const top = cfgRel.split('/')[0];
        if (!['plugins', 'themes', 'snippets'].includes(top)) continue;
        if (top === 'plugins' && cfgRel.split('/')[1] === 'obsidian-cloud') continue;
      }
      out.push({ rel, kind: 'folder' });
      await walk(abs, rel, out, inConfig);
    } else if (e.isFile()) {
      if (inConfig && !wantConfigFile(rel.slice('.obsidian/'.length))) continue;
      out.push({ rel, kind: 'file', abs });
    }
  }
}

// ── HTTP with token refresh + rate-limit backoff ─────────────────────────────
let tokens = null;
let me = null;
async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: args.email, password: args.password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  tokens = { ...body.tokens, at: Date.now() };
  me = body.user;
}
let refreshing = null;
async function refresh() {
  refreshing ??= (async () => {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!res.ok) await login();
    else tokens = { ...(await res.json()).tokens, at: Date.now() };
  })().finally(() => (refreshing = null));
  return refreshing;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, attempt = 0) {
  if (Date.now() - tokens.at > (tokens.expiresIn - 60) * 1000) await refresh();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens.accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && attempt < 2) {
    await refresh();
    return api(method, path, body, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 502) && attempt < 8) {
    await sleep(Math.min(60_000, 2000 * 2 ** attempt));
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── E2EE ─────────────────────────────────────────────────────────────────────
let recipients = []; // [{ userId, key: CryptoKey }]
let privateKey = null;
async function setupKeys() {
  let keys;
  try {
    keys = await api('GET', '/e2ee/keys/me');
  } catch (err) {
    if (!String(err.message).includes('→ 404')) throw err;
    console.log('No E2EE keys on this account yet — creating them with the given passphrase.');
    const created = await e2.createUserKeys(args.passphrase);
    await api('POST', '/e2ee/keys', {
      publicKey: created.publicKeyB64,
      encryptedPrivateKey: created.encryptedPrivateKey,
      kdfSalt: created.kdfSalt,
    });
    keys = { publicKey: created.publicKeyB64, encryptedPrivateKey: created.encryptedPrivateKey, kdfSalt: created.kdfSalt };
  }
  const wrapping = await e2.deriveWrappingKey(args.passphrase, keys.kdfSalt);
  try {
    privateKey = await e2.unwrapPrivateKey(keys.encryptedPrivateKey, wrapping);
  } catch {
    throw new Error('Wrong E2EE passphrase for this account.');
  }
  const admins = await api('GET', '/e2ee/admin-keys');
  const all = [{ userId: me.id, publicKey: keys.publicKey }, ...admins.filter((a) => a.userId !== me.id)];
  recipients = await Promise.all(all.map(async (r) => ({ userId: r.userId, key: await e2.importPublicKey(r.publicKey) })));
  console.log(`Keys ready; content keys are wrapped for ${recipients.length} user(s) (you + admins).`);
}
async function storeKey(docId, contentKey) {
  const entries = await Promise.all(
    recipients.map(async (r) => ({ userId: r.userId, wrappedKey: await e2.wrapContentKeyForUser(contentKey, r.key) })),
  );
  await api('PUT', `/e2ee/document-keys/${docId}`, { entries });
}
async function createNode(parentId, kind, name, extra = {}) {
  const contentKey = await e2.generateContentKey();
  const node = await api('POST', '/nodes', {
    parentId,
    kind,
    name: await e2.encryptString(contentKey, name, 'name'),
    ...extra,
  });
  await storeKey(node.docId, contentKey);
  return { node, contentKey };
}

// ── state (resume) ───────────────────────────────────────────────────────────
let state = { server: SERVER, vaultId: null, vaultDocId: null, items: {} };
async function saveState() {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 1));
}

async function findOrCreateVault() {
  if (state.vaultId) {
    const tree = await api('GET', '/tree');
    if (tree.nodes.some((n) => n.id === state.vaultId)) return state.vaultId;
    console.log('Vault from state file no longer exists — starting over.');
    state = { server: SERVER, vaultId: null, vaultDocId: null, items: {} };
  }
  const { node } = await createNode(null, 'folder', VAULT_NAME, { isVault: true });
  state.vaultId = node.id;
  state.vaultDocId = node.docId;
  await saveState();
  console.log(`Created vault “${VAULT_NAME}” (${node.id}).`);
  return node.id;
}

/** Upload one file's content into an existing node. */
async function uploadContent(item, docId, contentKey) {
  const bytes = new Uint8Array(await readFile(item.abs));
  if (isTextFileName(item.rel) && !item.rel.startsWith('.obsidian/')) {
    const doc = new Y.Doc();
    doc.getText(YTEXT_FIELD).insert(0, new TextDecoder().decode(bytes));
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const enc = await e2.encryptBytes(contentKey, update, 'yupdate');
    await api('POST', `/documents/${docId}/updates`, {
      dataBase64: e2.toBase64(enc),
      mtime: new Date(item.mtime).toISOString(),
    });
  } else {
    const enc = await e2.encryptBytes(contentKey, bytes, 'blob');
    await api('PUT', `/documents/${docId}/blob`, { contentBase64: e2.toBase64(enc), mime: mimeOf(item.rel) });
  }
}

async function main() {
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (state.server !== SERVER) throw new Error(`state file ${STATE_FILE} belongs to ${state.server}`);
  }
  const items = [];
  await walk(DIR, '', items, false);
  const files = items.filter((i) => i.kind === 'file');
  let skippedLarge = [];
  for (const f of files) {
    const st = await stat(f.abs);
    f.size = st.size;
    f.mtime = Math.min(st.mtimeMs, Date.now());
    if (f.size > MAX_BLOB_BYTES) skippedLarge.push(f.rel);
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  console.log(
    `${items.length - files.length} folders, ${files.length} files (${(total / 1048576).toFixed(1)} MB) in ${DIR}` +
      (skippedLarge.length ? `; ${skippedLarge.length} above the size limit will be skipped` : ''),
  );
  if (args['dry-run']) {
    for (const i of items) console.log(`${i.kind === 'folder' ? 'D' : 'F'} ${i.rel}`);
    return;
  }

  await login();
  console.log(`Signed in as ${me.email}${me.isAdmin ? ' (admin)' : ''}.`);
  await setupKeys();
  const vaultId = await findOrCreateVault();

  // The vault's `.obsidian` is the server-protected config folder: plugin code
  // in it runs for everyone opening the vault, so only admins and plugin
  // admins may upload it.
  if (!me.isAdmin && !me.isPluginAdmin) {
    const n = items.length;
    items.splice(0, n, ...items.filter((i) => i.rel !== '.obsidian' && !i.rel.startsWith('.obsidian/')));
    files.splice(0, files.length, ...files.filter((f) => !f.rel.startsWith('.obsidian/')));
    if (items.length < n) console.log('Skipping .obsidian (plugins/settings): only admins and plugin admins may upload them.');
  }

  // Folders first, sequentially (parents before children).
  const idOf = (rel) => (rel === '' ? vaultId : state.items[rel]?.id);
  const parentRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  for (const f of items.filter((i) => i.kind === 'folder')) {
    if (state.items[f.rel]) continue;
    const extra = f.rel === '.obsidian' ? { systemType: 'config' } : {};
    const { node } = await createNode(idOf(parentRel(f.rel)), 'folder', f.rel.split('/').pop(), extra);
    state.items[f.rel] = { id: node.id, docId: node.docId, done: true };
    await saveState();
  }
  console.log('Folders created.');

  // Files in parallel batches. A file is "done" only after its content landed;
  // a half-imported file (node created, content missing) is completed on the
  // next run with a fresh key... except we can't re-key: so we delete & redo it.
  const todo = files.filter((f) => !state.items[f.rel]?.done && f.size <= MAX_BLOB_BYTES);
  let done = 0;
  let failed = 0;
  const started = Date.now();
  async function one(f) {
    const prev = state.items[f.rel];
    if (prev && !prev.done) {
      await api('DELETE', `/nodes/${prev.id}`).catch(() => undefined);
      delete state.items[f.rel];
    }
    const isText = isTextFileName(f.rel) && !f.rel.startsWith('.obsidian/');
    const { node, contentKey } = await createNode(idOf(parentRel(f.rel)), 'file', f.rel.split('/').pop(), {
      isText,
      ...(isText ? {} : { mime: mimeOf(f.rel) }),
    });
    state.items[f.rel] = { id: node.id, docId: node.docId, done: false };
    await uploadContent(f, node.docId, contentKey);
    state.items[f.rel].done = true;
  }
  const queue = [...todo];
  let lastSave = Date.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const f = queue.shift();
        try {
          await one(f);
          done++;
        } catch (err) {
          failed++;
          console.error(`✗ ${f.rel}: ${err.message}`);
        }
        if (Date.now() - lastSave > 2000) {
          lastSave = Date.now();
          await saveState();
          const rate = done / ((Date.now() - started) / 1000);
          process.stdout.write(`  ${done}/${todo.length} files (${rate.toFixed(1)}/s)\n`);
        }
      }
    }),
  );
  await saveState();
  console.log(`Imported ${done} file(s), ${failed} failed, ${files.length - todo.length} already present.`);
  if (skippedLarge.length) console.log(`Skipped (too large): ${skippedLarge.join(', ')}`);
  console.log(`Vault id: ${vaultId}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
