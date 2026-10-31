#!/usr/bin/env node
/**
 * Verify an imported vault: download + decrypt every name and every note /
 * attachment of a server vault and compare them byte-for-byte with a local
 * vault directory. Read-only on both sides.
 *
 *   node verify-vault.mjs --server URL --email E --password P --passphrase PP \
 *     --dir "/path/to/Vault" [--vault-name "Vault"]
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Y = require('yjs');
const e2 = require('@oc/shared/crypto');
const { YTEXT_FIELD } = require('@oc/shared');

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    passphrase: { type: 'string' },
    dir: { type: 'string' },
    'vault-name': { type: 'string' },
  },
});
const API = `${args.server.replace(/\/+$/, '')}/api`;
const VAULT_NAME = args['vault-name'] ?? basename(args.dir);

let token;
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: args.email, password: args.password }),
}).then((r) => r.json());
token = login.tokens.accessToken;
const keys = await api('GET', '/e2ee/keys/me');
const priv = await e2.unwrapPrivateKey(keys.encryptedPrivateKey, await e2.deriveWrappingKey(args.passphrase, keys.kdfSalt));
const wrapped = new Map((await api('GET', '/e2ee/document-keys')).map((k) => [k.docId, k.wrappedKey]));
const keyCache = new Map();
async function keyOf(docId) {
  if (!keyCache.has(docId)) keyCache.set(docId, await e2.unwrapContentKey(wrapped.get(docId), priv));
  return keyCache.get(docId);
}

const { nodes } = await api('GET', '/tree');
const byId = new Map(nodes.map((n) => [n.id, n]));
const names = new Map();
for (const n of nodes) {
  if (n.docId && wrapped.has(n.docId)) names.set(n.id, await e2.decryptString(await keyOf(n.docId), n.name, 'name'));
}
const vault = nodes.find((n) => n.isVault && names.get(n.id) === VAULT_NAME);
if (!vault) throw new Error(`vault ${VAULT_NAME} not found`);
const pathOf = (n) => (n.id === vault.id ? '' : [pathOf(byId.get(n.parentId)), names.get(n.id)].filter(Boolean).join('/'));
const inVault = nodes.filter((n) => n.path.startsWith(`${vault.path}/`));
let ok = 0;
const bad = [];
const texts = inVault.filter((n) => n.kind === 'file' && n.isText);
for (let i = 0; i < texts.length; i += 200) {
  const { docs } = await api('POST', '/documents/updates', { docIds: texts.slice(i, i + 200).map((n) => n.docId) });
  for (const d of docs) {
    const n = texts.find((t) => t.docId === d.docId);
    const doc = new Y.Doc();
    for (const u of d.updates) Y.applyUpdate(doc, await e2.decryptBytes(await keyOf(d.docId), e2.fromBase64(u), 'yupdate'));
    const server = doc.getText(YTEXT_FIELD).toString();
    const local = await readFile(join(args.dir, pathOf(n)), 'utf8');
    if (server === local) ok++;
    else bad.push(pathOf(n));
  }
}
for (const n of inVault.filter((x) => x.kind === 'file' && !x.isText)) {
  const blob = await api('GET', `/documents/${n.docId}/blob`);
  const bytes = await e2.decryptBytes(await keyOf(n.docId), e2.fromBase64(blob.contentBase64), 'blob');
  const p = join(args.dir, pathOf(n));
  const local = existsSync(p) ? new Uint8Array(await readFile(p)) : null;
  if (local && local.length === bytes.length && local.every((b, i) => b === bytes[i])) ok++;
  else bad.push(pathOf(n));
}
console.log(`${ok} identical, ${bad.length} different/missing; ${inVault.filter((n) => n.kind === 'folder').length} folders`);
for (const b of bad) console.log(`  ✗ ${b}`);
process.exit(bad.length ? 1 : 0);
