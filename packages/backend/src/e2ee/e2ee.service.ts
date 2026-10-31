import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  hasCapability,
  type RegisterKeysRequest,
  type UserKeysDto,
  type PublicKeyDto,
  type DocumentKeyDto,
  type GranteeKeyDto,
  type SetDocumentKeysRequest,
} from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService, type Principal } from '../acl/acl.service';

/**
 * Stores E2EE key material. Everything here is opaque base64 produced and
 * consumed by clients — the server never sees a plaintext key or content.
 */
@Injectable()
export class E2eeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  async registerKeys(userId: string, dto: RegisterKeysRequest): Promise<void> {
    // Replacing the key pair orphans every content key wrapped for the old
    // public key — all E2EE data would become undecryptable. Require an
    // explicit `force` so a racing second device cannot silently do that.
    if (!dto.force) {
      const existing = await this.prisma.userKey.findUnique({ where: { userId } });
      if (existing) {
        throw new ConflictException(
          'E2EE keys are already registered for this account. Unlock with your passphrase instead.',
        );
      }
    }
    await this.prisma.userKey.upsert({
      where: { userId },
      create: {
        userId,
        publicKey: dto.publicKey,
        encryptedPrivateKey: dto.encryptedPrivateKey,
        kdfSalt: dto.kdfSalt,
      },
      update: {
        publicKey: dto.publicKey,
        encryptedPrivateKey: dto.encryptedPrivateKey,
        kdfSalt: dto.kdfSalt,
      },
    });
  }

  async getMyKeys(userId: string): Promise<UserKeysDto> {
    const k = await this.prisma.userKey.findUnique({ where: { userId } });
    if (!k) throw new NotFoundException('No E2EE keys set up');
    return { publicKey: k.publicKey, encryptedPrivateKey: k.encryptedPrivateKey, kdfSalt: k.kdfSalt };
  }

  async listPublicKeys(user: Principal): Promise<PublicKeyDto[]> {
    // The user directory (emails!) is only revealed to accounts that can
    // actually share something — admins or holders of a 'share' grant.
    if (!(await this.acl.canShareAnywhere(user))) {
      throw new ForbiddenException("Requires the 'share' permission somewhere in the vault");
    }
    const users = await this.prisma.user.findMany({
      select: { id: true, email: true, displayName: true, userKey: { select: { publicKey: true } } },
      orderBy: { displayName: 'asc' },
    });
    return users.map((u) => ({
      userId: u.id,
      email: u.email,
      displayName: u.displayName,
      publicKey: u.userKey?.publicKey ?? null,
    }));
  }

  /**
   * Every wrapped key belonging to the caller, in one request (sync clients
   * prime their cache with this instead of one request per node). The keys are
   * already user-scoped — each is wrapped for the caller's public key — so no
   * per-node ACL check is needed; nodes the user cannot read are absent from
   * /tree and their keys are never used.
   */
  async listMyDocumentKeys(userId: string): Promise<DocumentKeyDto[]> {
    return this.prisma.documentKey.findMany({
      where: { userId },
      select: { docId: true, wrappedKey: true },
    });
  }

  /**
   * Public keys of all admins (who have access to every file). Any signed-in
   * user may fetch these to wrap their documents' content keys for admins — the
   * response carries only userId + public key, no emails.
   */
  async listAdminKeys(): Promise<GranteeKeyDto[]> {
    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true, userKey: { isNot: null } },
      select: { id: true, userKey: { select: { publicKey: true } } },
    });
    return admins
      .filter((a) => a.userKey)
      .map((a) => ({ userId: a.id, publicKey: a.userKey!.publicKey }));
  }

  /**
   * The documents the caller can decrypt for which at least one admin (with a
   * key pair) still lacks a wrapped key. Lets clients backfill admin keys for
   * just the gaps instead of re-wrapping every document (which, on a large
   * vault, is hundreds of requests and trips the rate limit). Reveals nothing
   * new: only ids of documents the caller already holds keys for.
   */
  async adminKeyGaps(user: Principal): Promise<{ docIds: string[] }> {
    const admins = (await this.listAdminKeys()).map((a) => a.userId);
    if (admins.length === 0) return { docIds: [] };
    const mine = await this.prisma.documentKey.findMany({
      where: { userId: user.userId },
      select: { docId: true },
    });
    const docIds = mine.map((m) => m.docId);
    if (docIds.length === 0) return { docIds: [] };
    const held = await this.prisma.documentKey.findMany({
      where: { docId: { in: docIds }, userId: { in: admins } },
      select: { docId: true },
    });
    const count = new Map<string, number>();
    for (const h of held) count.set(h.docId, (count.get(h.docId) ?? 0) + 1);
    return { docIds: docIds.filter((d) => (count.get(d) ?? 0) < admins.length) };
  }

  /**
   * Public keys of every OTHER user who already has read access to this
   * document's subtree — so the caller can wrap a freshly created node's
   * content key for them (a note created in a shared folder). Includes admins
   * (who read everything). The caller must be able to read the node; the
   * response carries no emails.
   */
  async listGrantees(user: Principal, docId: string): Promise<GranteeKeyDto[]> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node) throw new NotFoundException('Document not found');
    await this.acl.requireCapability(user, node.path, 'read');

    const readers = await this.acl.effectiveReaders(node.path);
    const others = readers.filter((id) => id !== user.userId);
    if (others.length === 0) return [];
    const keys = await this.prisma.userKey.findMany({
      where: { userId: { in: others } },
      select: { userId: true, publicKey: true },
    });
    return keys.map((k) => ({ userId: k.userId, publicKey: k.publicKey }));
  }

  async getDocumentKey(user: Principal, docId: string): Promise<DocumentKeyDto> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node) throw new NotFoundException('Document not found');
    // The plugin folder is readable by everyone; other docs need read.
    await this.acl.requireCapability(user, node.path, 'read');

    const k = await this.prisma.documentKey.findUnique({
      where: { docId_userId: { docId, userId: user.userId } },
    });
    if (!k) throw new NotFoundException('No key for this document');
    return { docId, wrappedKey: k.wrappedKey };
  }

  async setDocumentKeys(user: Principal, docId: string, dto: SetDocumentKeysRequest): Promise<void> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node) throw new NotFoundException('Document not found');

    // The caller must hold the content key (read access). Adding keys for OTHER
    // users normally requires 'share' — EXCEPT when the target is already
    // entitled to read this subtree (an explicit grantee, or an admin, who has
    // access to all files): then it's not a new grant, just provisioning the
    // key they're owed (e.g. a note created in a shared folder, or keying it
    // for admins).
    const callerCaps = await this.acl.requireCapability(user, node.path, 'read');
    const others = dto.entries.filter((e) => e.userId !== user.userId);
    if (others.length > 0 && !hasCapability(callerCaps, 'share')) {
      const entitled = new Set(await this.acl.effectiveReaders(node.path)); // includes admins
      for (const e of others) {
        if (!entitled.has(e.userId)) {
          throw new ForbiddenException(
            "Requires 'share' to key this document for a user without access",
          );
        }
      }
    }

    await this.prisma.$transaction(
      dto.entries.map((e) =>
        this.prisma.documentKey.upsert({
          where: { docId_userId: { docId, userId: e.userId } },
          create: { docId, userId: e.userId, wrappedKey: e.wrappedKey },
          update: { wrappedKey: e.wrappedKey },
        }),
      ),
    );
  }

  /** Revoke a user's wrapped content key for a document (requires 'share'). */
  async removeDocumentKey(user: Principal, docId: string, targetUserId: string): Promise<void> {
    const node = await this.prisma.node.findUnique({ where: { docId } });
    if (!node) throw new NotFoundException('Document not found');
    await this.acl.requireCapability(user, node.path, 'share');

    // Deleting the LAST wrapped copy destroys the document forever — the
    // server only stores ciphertext. This happens naturally when revoking a
    // folder grant: notes the target created inside are keyed only for them.
    const holders = await this.prisma.documentKey.findMany({
      where: { docId },
      select: { userId: true },
    });
    if (holders.length === 1 && holders[0].userId === targetUserId) {
      throw new ConflictException(
        'Cannot revoke the only key for this document — its content would be unrecoverable',
      );
    }

    // A subtree revoke must not strip keys the target still legitimately
    // holds through another (deeper or separate) grant.
    const remaining = await this.acl.effectiveCapabilities(
      { userId: targetUserId, isAdmin: false },
      node.path,
    );
    if (remaining?.includes('read')) return;

    await this.prisma.documentKey.deleteMany({ where: { docId, userId: targetUserId } });
  }
}
