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
} from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService, type Principal } from '../acl/acl.service';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
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
    await this.acl.requireReadable(user, node.path);

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
}
