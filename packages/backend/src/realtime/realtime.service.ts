import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WS_DOC_PATH, hasCapability } from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService } from '../acl/acl.service';
import type { AccessTokenPayload } from '../auth/token.service';

// Wire framing: [1 byte type][payload]. Matches @oc/shared/yjs-provider.
const T_UPDATE = 1;
const T_AWARENESS = 2;
const T_SYNCED = 3;
const T_REPLACE = 4;

interface Conn {
  ws: WebSocket;
  docId: string;
  userId: string;
  isAdmin: boolean;
  readOnly: boolean;
  /** Ids of the stored updates replayed to this connection. A REPLACE frame
   *  from this client provably contains exactly these rows, so exactly these
   *  rows may be deleted during compaction. (Not "everything ≤ max id":
   *  Postgres ids are allocated at insert time, so a row committed after the
   *  replay query can have a smaller id and must survive.) */
  replayedIds: bigint[];
  /** Unix seconds when the presented access token expires. */
  tokenExp: number;
  /** Last ACL re-validation (ms epoch); grants are re-checked periodically so
   *  a revocation doesn't leave the socket usable until it disconnects. */
  lastAclCheck: number;
}

/** How often a live connection's ACL is re-validated. */
const ACL_RECHECK_MS = 60_000;
/** Upper bound for a single frame: far above any real Yjs update/snapshot,
 *  far below what would let one client inflate the DB per message. */
const MAX_WS_PAYLOAD = 16 * 1024 * 1024;

/**
 * Zero-knowledge realtime relay. It stores and forwards only ENCRYPTED Yjs
 * update blobs — it never holds a document's content key and cannot read the
 * content. Access (per document, read vs write) is still enforced server-side
 * via JWT + ACL on connect; write frames from read-only connections are dropped.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private wss!: WebSocketServer;
  private readonly rooms = new Map<string, Set<Conn>>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly acl: AclService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;

    httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith(`${WS_DOC_PATH}/`)) {
        socket.destroy();
        return;
      }
      this.authorize(url)
        .then((auth) => {
          if (!auth) {
            socket.destroy();
            return;
          }
          this.wss.handleUpgrade(req, socket, head, (ws) => void this.onConnection(ws, auth));
        })
        .catch(() => socket.destroy());
    });

    this.logger.log(`Encrypted realtime relay mounted at ${WS_DOC_PATH}/:docId`);
  }

  /** Validate the token + per-document access. Returns null to reject. */
  private async authorize(
    url: URL,
  ): Promise<{ docId: string; userId: string; isAdmin: boolean; readOnly: boolean; tokenExp: number } | null> {
    const docId = decodeURIComponent(url.pathname.slice(`${WS_DOC_PATH}/`.length));
    if (!docId) return null;

    let payload: AccessTokenPayload & { exp?: number };
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload & { exp?: number }>(
        url.searchParams.get('token') ?? '',
        { secret: this.config.get<string>('jwt.accessSecret') },
      );
    } catch {
      return null;
    }

    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node) return null;
    const caps = await this.acl.effectiveCapabilities(
      { userId: payload.sub, isAdmin: payload.isAdmin },
      node.path,
    );
    if (!caps || !hasCapability(caps, 'read')) return null;
    return {
      docId,
      userId: payload.sub,
      isAdmin: payload.isAdmin,
      readOnly: !hasCapability(caps, 'edit'),
      tokenExp: payload.exp ?? Math.floor(Date.now() / 1000) + 900,
    };
  }

  private async onConnection(
    ws: WebSocket,
    auth: { docId: string; userId: string; isAdmin: boolean; readOnly: boolean; tokenExp: number },
  ): Promise<void> {
    const { docId } = auth;
    const conn: Conn = {
      ws,
      docId,
      userId: auth.userId,
      isAdmin: auth.isAdmin,
      readOnly: auth.readOnly,
      replayedIds: [],
      tokenExp: auth.tokenExp,
      lastAclCheck: Date.now(),
    };
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Set();
      this.rooms.set(docId, room);
    }
    room.add(conn);

    ws.on('message', (data: Buffer) => void this.onMessage(conn, data));
    ws.on('close', () => {
      const r = this.rooms.get(docId);
      r?.delete(conn);
      if (r && r.size === 0) this.rooms.delete(docId);
    });
    ws.on('error', () => ws.close());

    // Replay the stored encrypted log, then signal initial sync is complete.
    try {
      const updates = await this.prisma.docUpdate.findMany({
        where: { docId },
        orderBy: { id: 'asc' },
        select: { id: true, data: true },
      });
      for (const u of updates) {
        ws.send(this.frame(T_UPDATE, u.data));
        conn.replayedIds.push(u.id);
      }
    } catch (err) {
      this.logger.warn(`Failed to load updates for ${docId}: ${(err as Error).message}`);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([T_SYNCED]));
  }

  private async onMessage(conn: Conn, data: Buffer): Promise<void> {
    if (data.length === 0) return;

    // Connect-time auth is not enough for a long-lived socket: enforce token
    // expiry, and periodically re-check the ACL so a revoked grant actually
    // cuts the connection off instead of lasting until the next disconnect.
    if (conn.tokenExp * 1000 <= Date.now()) {
      conn.ws.close(4401, 'token expired');
      return;
    }
    if (Date.now() - conn.lastAclCheck > ACL_RECHECK_MS) {
      conn.lastAclCheck = Date.now();
      const node = await this.prisma.node.findUnique({ where: { docId: conn.docId } });
      const caps = node
        ? await this.acl.effectiveCapabilities({ userId: conn.userId, isAdmin: conn.isAdmin }, node.path)
        : null;
      if (!caps || !hasCapability(caps, 'read')) {
        conn.ws.close(4403, 'access revoked');
        return;
      }
      conn.readOnly = !hasCapability(caps, 'edit');
    }

    const type = data[0];
    const payload = data.subarray(1);

    if (type === T_UPDATE) {
      if (conn.readOnly) return; // read-only connections cannot write
      try {
        await this.prisma.docUpdate.create({ data: { docId: conn.docId, data: Buffer.from(payload) } });
      } catch (err) {
        this.logger.warn(`Persist failed for ${conn.docId}: ${(err as Error).message}`);
        return;
      }
      this.broadcast(conn, this.frame(T_UPDATE, payload));
    } else if (type === T_REPLACE) {
      // Compaction: the client sends its full (encrypted) doc state, which by
      // construction contains every update replayed to it. Collapse exactly
      // those rows into the one new row; anything else (including rows that
      // committed after the replay query with a smaller id) is kept — Yjs
      // merges are idempotent, so overlap is harmless.
      if (conn.readOnly) return;
      try {
        const [, created] = await this.prisma.$transaction([
          this.prisma.docUpdate.deleteMany({
            where: { docId: conn.docId, id: { in: conn.replayedIds } },
          }),
          this.prisma.docUpdate.create({ data: { docId: conn.docId, data: Buffer.from(payload) } }),
        ]);
        conn.replayedIds = [created.id];
      } catch (err) {
        this.logger.warn(`Compaction failed for ${conn.docId}: ${(err as Error).message}`);
        return;
      }
      // Peers still need the client's (possibly offline) changes.
      this.broadcast(conn, this.frame(T_UPDATE, payload));
    } else if (type === T_AWARENESS) {
      // Awareness is ephemeral; relay it (still encrypted) without storing.
      this.broadcast(conn, this.frame(T_AWARENESS, payload));
    }
  }

  /** Forward an update persisted via REST to every live connection. */
  broadcastUpdate(docId: string, payload: Uint8Array): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    const f = this.frame(T_UPDATE, payload);
    for (const c of room) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(f);
  }

  private broadcast(from: Conn, frame: Buffer): void {
    const room = this.rooms.get(from.docId);
    if (!room) return;
    for (const c of room) {
      if (c !== from && c.ws.readyState === WebSocket.OPEN) c.ws.send(frame);
    }
  }

  private frame(type: number, payload: Uint8Array): Buffer {
    const out = Buffer.allocUnsafe(payload.length + 1);
    out[0] = type;
    Buffer.from(payload).copy(out, 1);
    return out;
  }

  onModuleDestroy(): void {
    this.wss?.close();
  }
}
