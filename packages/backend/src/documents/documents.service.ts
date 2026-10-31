import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  hasCapability,
  roleLabelForCapabilities,
  MAX_BLOB_BYTES,
  type DocumentBootstrapDto,
  type BlobInfoDto,
  type BlobContentDto,
  type BatchUpdatesResponse,
  MAX_BATCH_UPDATES,
} from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService, type Principal } from '../acl/acl.service';
import { RealtimeService } from '../realtime/realtime.service';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Metadata + the caller's effective role, fetched before opening the live doc. */
  async bootstrap(user: Principal, docId: string): Promise<DocumentBootstrapDto> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node || node.kind !== 'file') throw new NotFoundException('Document not found');

    const caps = await this.acl.effectiveCapabilities(user, node.path);
    if (!caps || !hasCapability(caps, 'read')) throw new ForbiddenException('Access denied');

    return {
      docId,
      path: node.path,
      isText: node.isText,
      mime: node.mime,
      role: roleLabelForCapabilities(caps),
      capabilities: caps,
      writable: hasCapability(caps, 'edit'),
    };
  }

  /** Upload (or replace) the binary contents of a non-text file. Requires editor. */
  async uploadBlob(
    user: Principal,
    docId: string,
    contentBase64: string,
    mime?: string,
  ): Promise<BlobInfoDto> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node || node.kind !== 'file') throw new NotFoundException('Document not found');
    await this.acl.requireCapability(user, node.path, 'edit');

    const content = Buffer.from(contentBase64, 'base64');
    // Ciphertext carries a small AES-GCM overhead over the plaintext limit.
    if (content.length > MAX_BLOB_BYTES + 1024) {
      throw new BadRequestException(
        `Attachment exceeds the ${Math.round(MAX_BLOB_BYTES / 1024 / 1024)} MB limit`,
      );
    }
    const sha256 = createHash('sha256').update(content).digest('hex');
    const blob = await this.prisma.blob.upsert({
      where: { docId },
      create: { docId, content, sha256, size: content.length },
      update: { content, sha256, size: content.length },
    });
    if (mime && mime !== node.mime) {
      await this.prisma.node.update({ where: { id: node.id }, data: { mime, isText: false } });
    }
    return {
      docId,
      sha256: blob.sha256,
      size: blob.size,
      mime: mime ?? node.mime,
      updatedAt: blob.updatedAt.toISOString(),
    };
  }

  /** Download the binary contents. Requires viewer. */
  async getBlob(user: Principal, docId: string): Promise<BlobContentDto> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node || node.kind !== 'file') throw new NotFoundException('Document not found');
    // The plugin folder is downloadable by everyone; other files need read.
    await this.acl.requireCapability(user, node.path, 'read');

    const blob = await this.prisma.blob.findUnique({ where: { docId } });
    if (!blob) throw new NotFoundException('No content has been uploaded');
    return {
      docId,
      mime: node.mime,
      sha256: blob.sha256,
      size: blob.size,
      contentBase64: Buffer.from(blob.content).toString('base64'),
    };
  }

  /**
   * The encrypted Yjs logs of several text documents in one round trip, so a
   * client can index a whole vault (search, backlinks, plugins) without one
   * WebSocket per note. Still ciphertext only; documents the caller can't read
   * are silently omitted (no existence oracle beyond what /tree reveals).
   */
  async batchUpdates(user: Principal, docIds: string[]): Promise<BatchUpdatesResponse> {
    const ids = [...new Set(docIds)].slice(0, MAX_BATCH_UPDATES);
    if (ids.length === 0) return { docs: [] };
    const nodes = await this.prisma.node.findMany({
      where: { docId: { in: ids }, kind: 'file', isText: true },
      select: { docId: true, path: true },
    });
    const readable: string[] = [];
    for (const n of nodes) {
      if (!n.docId) continue;
      if (user.isAdmin) {
        readable.push(n.docId);
        continue;
      }
      const caps = await this.acl.effectiveCapabilities(user, n.path);
      if (caps && hasCapability(caps, 'read')) readable.push(n.docId);
    }
    if (readable.length === 0) return { docs: [] };
    const rows = await this.prisma.docUpdate.findMany({
      where: { docId: { in: readable } },
      orderBy: { id: 'asc' },
      select: { docId: true, data: true, createdAt: true },
    });
    const byDoc = new Map<string, { updates: string[]; at: Date | null }>(
      readable.map((d) => [d, { updates: [], at: null }]),
    );
    for (const r of rows) {
      const e = byDoc.get(r.docId);
      if (!e) continue;
      e.updates.push(Buffer.from(r.data).toString('base64'));
      if (!e.at || r.createdAt > e.at) e.at = r.createdAt;
    }
    return {
      docs: [...byDoc.entries()].map(([docId, e]) => ({
        docId,
        updates: e.updates,
        updatedAt: e.at?.toISOString() ?? null,
      })),
    };
  }

  /** Append one encrypted Yjs update to a text document's log (REST twin of
   *  a relay T_UPDATE frame) and forward it to connected peers. */
  async appendUpdate(user: Principal, docId: string, dataBase64: string, mtime?: string): Promise<void> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node || node.kind !== 'file' || !node.isText) throw new NotFoundException('Document not found');
    await this.acl.requireCapability(user, node.path, 'edit');
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length === 0) throw new BadRequestException('Empty update');
    if (data.length > 16 * 1024 * 1024) throw new BadRequestException('Update too large');
    // A backdated timestamp only affects the displayed content mtime; never
    // accept one from the future (it would pin the note as "newest").
    const at = mtime ? new Date(mtime) : undefined;
    const createdAt = at && !Number.isNaN(at.getTime()) && at.getTime() <= Date.now() ? at : undefined;
    await this.prisma.docUpdate.create({ data: { docId, data, ...(createdAt ? { createdAt } : {}) } });
    this.realtime.broadcastUpdate(docId, data);
  }
}
