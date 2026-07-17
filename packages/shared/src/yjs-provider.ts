import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  type Awareness,
} from 'y-protocols/awareness';
import { encryptBytes, decryptBytes, type CryptoPurpose } from './crypto';
import { COMPACT_AFTER_UPDATES } from './constants';

/**
 * A Yjs network provider for a Zero-Knowledge relay. Every Yjs update and
 * awareness message is AES-GCM encrypted with the document's content key before
 * it leaves the device, so the relay only ever sees ciphertext. Works in the
 * browser, Electron/Obsidian and Node (uses the global WebSocket + Web Crypto).
 *
 * Wire framing: [1 byte type][payload]. type 1 = update, 2 = awareness,
 * 3 = synced (server → client), 4 = replace (client compaction → server).
 */
const T_UPDATE = 1;
const T_AWARENESS = 2;
const T_SYNCED = 3;
const T_REPLACE = 4;

function frame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export interface EncryptedProviderOptions {
  /** WebSocket base, e.g. wss://host/ws/doc */
  url: string;
  docId: string;
  doc: Y.Doc;
  contentKey: CryptoKey;
  /** May be async so callers can refresh an expired token before a reconnect
   *  (the WebSocket handshake has no 401-retry path). */
  getToken: () => string | null | Promise<string | null>;
  awareness?: Awareness;
  onStatus?: (connected: boolean) => void;
  onSynced?: () => void;
  /** Whether this client may compact the relay's stored log (writable access).
   *  The relay drops compaction frames from read-only connections anyway;
   *  this only avoids sending them in vain. Default: true. */
  canCompact?: () => boolean;
}

const RECONNECT_MIN_MS = 1500;
const RECONNECT_MAX_MS = 30_000;

export class EncryptedProvider {
  private ws: WebSocket | null = null;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly origin = Symbol('encrypted-provider');
  /** Serializes frame handling: decryption is async, and the T_SYNCED logic
   *  must only run after every replayed update has been applied. */
  private recvChain: Promise<void> = Promise.resolve();
  private replayCount = 0;
  /** A replayed frame failed to decrypt/apply — our state provably does NOT
   *  contain the whole log, so this connection must never compact (the relay
   *  would delete rows whose content our snapshot is missing). */
  private replayFailed = false;
  private syncedOnce = false;
  /** Local updates produced while the socket was down (they were never sent). */
  private localPending = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwareness?: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;

  constructor(private readonly opts: EncryptedProviderOptions) {
    this.onDocUpdate = (update, origin) => {
      if (origin === this.origin) return; // applied from the network — don't echo
      void this.send(T_UPDATE, update);
    };
    this.opts.doc.on('update', this.onDocUpdate);

    if (opts.awareness) {
      const awareness = opts.awareness;
      this.onAwareness = ({ added, updated, removed }, origin) => {
        if (origin === this.origin) return;
        const changed = [...added, ...updated, ...removed];
        void this.send(T_AWARENESS, encodeAwarenessUpdate(awareness, changed));
      };
      awareness.on('update', this.onAwareness);
    }

    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;
    this.replayCount = 0;
    this.replayFailed = false;
    this.syncedOnce = false;
    void (async () => {
      let token: string | null = null;
      try {
        token = await this.opts.getToken();
      } catch {
        /* token refresh failed — retry with backoff below */
      }
      if (this.destroyed) return;
      if (!token) {
        this.scheduleReconnect();
        return;
      }
      const ws = new WebSocket(`${this.opts.url}/${this.opts.docId}?token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.reconnectDelay = RECONNECT_MIN_MS; // healthy again — reset backoff
        this.opts.onStatus?.(true);
      };
      ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        this.recvChain = this.recvChain.then(() => this.onMessage(data)).catch(() => undefined);
      };
      ws.onclose = () => {
        this.opts.onStatus?.(false);
        this.scheduleReconnect();
      };
      ws.onerror = () => ws.close();
    })();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff: rejected connects (expired token, server down)
    // must not hammer the relay every 1.5 s indefinitely.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private async onMessage(data: Uint8Array): Promise<void> {
    if (data.length === 0) return;
    const type = data[0];
    const payload = data.subarray(1);
    try {
      if (type === T_UPDATE) {
        if (!this.syncedOnce) this.replayCount++;
        Y.applyUpdate(
          this.opts.doc,
          await decryptBytes(this.opts.contentKey, payload, 'yupdate'),
          this.origin,
        );
      } else if (type === T_AWARENESS && this.opts.awareness) {
        applyAwarenessUpdate(
          this.opts.awareness,
          await decryptBytes(this.opts.contentKey, payload, 'awareness'),
          this.origin,
        );
      } else if (type === T_SYNCED) {
        // The server has sent its stored log; push our (possibly offline) state
        // up. When the replayed backlog got large, send it as a REPLACE so the
        // relay collapses the log into this single (still encrypted) update —
        // the relay re-broadcasts it to peers as a normal update.
        // NEVER compact after a replay failure: a REPLACE claims our snapshot
        // contains the whole replayed log, and the relay deletes those rows —
        // any update we failed to apply would be destroyed for everyone.
        const compact =
          !this.syncedOnce &&
          !this.replayFailed &&
          this.replayCount > COMPACT_AFTER_UPDATES &&
          (this.opts.canCompact?.() ?? true);
        // Skip the redundant full-state append when nothing local is pending
        // and the server already has content — reconnect churn on large notes
        // otherwise grows the stored log by one snapshot per connect.
        if (compact || this.localPending || this.replayCount === 0) {
          await this.send(compact ? T_REPLACE : T_UPDATE, Y.encodeStateAsUpdate(this.opts.doc));
          this.localPending = false;
        }
        this.syncedOnce = true;
        this.opts.onSynced?.();
      }
    } catch {
      // Undecryptable / malformed frame. During replay this poisons
      // compaction (see above); live frames are simply dropped.
      if (type === T_UPDATE && !this.syncedOnce) this.replayFailed = true;
    }
  }

  private async send(type: number, plaintext: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Doc updates produced while offline are folded into the full-state
      // push on the next successful sync.
      if (type === T_UPDATE) this.localPending = true;
      return;
    }
    // T_REPLACE carries a full-state Yjs update; the relay re-broadcasts it as
    // a T_UPDATE, so it is bound with the same 'yupdate' purpose.
    const purpose: CryptoPurpose = type === T_AWARENESS ? 'awareness' : 'yupdate';
    try {
      ws.send(frame(type, await encryptBytes(this.opts.contentKey, plaintext, purpose)));
    } catch {
      if (type === T_UPDATE) this.localPending = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.opts.doc.off('update', this.onDocUpdate);
    if (this.opts.awareness && this.onAwareness) this.opts.awareness.off('update', this.onAwareness);
    this.ws?.close();
  }
}
