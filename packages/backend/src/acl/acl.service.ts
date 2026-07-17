import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Node as PrismaNode } from '@prisma/client';
import {
  ancestorPaths,
  capabilitiesForRole,
  hasCapability,
  roleLabelForCapabilities,
  isCapability,
  CAPABILITIES,
  ALL_CAPABILITIES,
  type Role,
  type Capability,
  type AclEntryDto,
  type AclListResponse,
  type SetAclRequest,
} from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Minimal authenticated principal needed for permission checks. */
export interface Principal {
  userId: string;
  isAdmin: boolean;
}

interface AclEntryRow {
  id: string;
  nodeId: string;
  userId: string;
  role: Role;
  capabilities: Capability[];
  user?: { email: string; displayName: string } | null;
}

/** A grant's capabilities: explicit if set, otherwise derived from its role. */
function grantCapabilities(role: Role, capabilities: Capability[]): Capability[] {
  return capabilities.length ? capabilities : capabilitiesForRole(role);
}

/** Dedupe, order, and ensure 'read' is implied when any capability is granted. */
function normalizeCapabilities(caps: Capability[]): Capability[] {
  const set = new Set<Capability>(caps.filter(isCapability));
  if (set.size > 0) set.add('read');
  return CAPABILITIES.filter((c) => set.has(c));
}

function toAclDto(entry: AclEntryRow): AclEntryDto {
  return {
    id: entry.id,
    nodeId: entry.nodeId,
    userId: entry.userId,
    role: entry.role,
    capabilities: grantCapabilities(entry.role, entry.capabilities),
    user: entry.user ? { email: entry.user.email, displayName: entry.user.displayName } : undefined,
  };
}

@Injectable()
export class AclService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Effective capabilities of `user` at `path`: the nearest explicit ancestor
   * grant wins (greatest depth; ties union). Admins get everything. Null = none.
   */
  async effectiveCapabilities(user: Principal, path: string): Promise<Capability[] | null> {
    if (user.isAdmin) return [...ALL_CAPABILITIES];

    const rows = await this.prisma.aclEntry.findMany({
      where: { userId: user.userId, node: { path: { in: ancestorPaths(path) } } },
      select: { role: true, capabilities: true, node: { select: { depth: true } } },
    });
    if (rows.length === 0) return null;

    let bestDepth = -1;
    let caps = new Set<Capability>();
    for (const r of rows) {
      const depth = r.node.depth;
      const rc = grantCapabilities(r.role as Role, r.capabilities as Capability[]);
      if (depth > bestDepth) {
        bestDepth = depth;
        caps = new Set(rc);
      } else if (depth === bestDepth) {
        rc.forEach((c) => caps.add(c));
      }
    }
    return [...caps];
  }

  /**
   * Whether the user holds the 'share' capability anywhere in the vault.
   * Gates access to the user directory (emails!): only accounts that can
   * actually share something get to see who exists.
   */
  async canShareAnywhere(user: Principal): Promise<boolean> {
    if (user.isAdmin) return true;
    const grants = await this.prisma.aclEntry.findMany({
      where: { userId: user.userId },
      select: { role: true, capabilities: true },
    });
    return grants.some((g) =>
      grantCapabilities(g.role as Role, g.capabilities as Capability[]).includes('share'),
    );
  }

  /**
   * Whether `path` is the central plugin folder or lives inside it. That folder
   * is auto-distributed to everyone, so it is readable by all users regardless
   * of explicit ACL.
   */
  async isInPluginsSubtree(path: string): Promise<boolean> {
    if (path === '') return false;
    const root = await this.prisma.node.findFirst({
      where: { systemType: 'plugins', path: { in: ancestorPaths(path) } },
      select: { id: true },
    });
    return root !== null;
  }

  /** Require `read` at `path`, but treat the plugin subtree as readable by every
   *  authenticated user (it is distributed to all). */
  async requireReadable(user: Principal, path: string): Promise<void> {
    if (user.isAdmin) return;
    const caps = await this.effectiveCapabilities(user, path);
    if (caps && hasCapability(caps, 'read')) return;
    if (await this.isInPluginsSubtree(path)) return;
    throw new ForbiddenException(`Requires 'read' permission on '${path || '/'}'`);
  }

  /**
   * User ids that may read at `path`: for the plugin subtree that is EVERY user
   * (it is auto-distributed). Otherwise everyone with an explicit `read` grant
   * on the node or an ancestor, plus every admin (admins read all files). Used
   * to fan out a node's content key to everyone entitled to it.
   */
  async effectiveReaders(path: string): Promise<string[]> {
    if (await this.isInPluginsSubtree(path)) {
      const all = await this.prisma.user.findMany({ select: { id: true } });
      return all.map((u) => u.id);
    }
    const readers = new Set<string>();
    // Admins can read everything.
    const admins = await this.prisma.user.findMany({
      where: { isAdmin: true },
      select: { id: true },
    });
    admins.forEach((a) => readers.add(a.id));
    // Explicit ACL grantees with read.
    const rows = await this.prisma.aclEntry.findMany({
      where: { node: { path: { in: ancestorPaths(path) } } },
      select: { userId: true },
      distinct: ['userId'],
    });
    for (const { userId } of rows) {
      if (readers.has(userId)) continue;
      const caps = await this.effectiveCapabilities({ userId, isAdmin: false }, path);
      if (caps && hasCapability(caps, 'read')) readers.add(userId);
    }
    return [...readers];
  }

  /** Effective role label at `path` (derived from capabilities). */
  async effectiveRole(user: Principal, path: string): Promise<Role | null> {
    const caps = await this.effectiveCapabilities(user, path);
    return caps ? roleLabelForCapabilities(caps) : null;
  }

  /** Throw ForbiddenException unless the user has `cap` at `path`. */
  async requireCapability(user: Principal, path: string, cap: Capability): Promise<Capability[]> {
    const caps = await this.effectiveCapabilities(user, path);
    if (!hasCapability(caps, cap)) {
      throw new ForbiddenException(`Requires '${cap}' permission on '${path || '/'}'`);
    }
    return caps as Capability[];
  }

  async listAcl(user: Principal, nodeId: string): Promise<AclListResponse> {
    const node = await this.nodeOr404(nodeId);
    const effectiveCapabilities = await this.requireCapability(user, node.path, 'share');
    const entries = await this.prisma.aclEntry.findMany({
      where: { nodeId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    return {
      entries: entries.map((e) => toAclDto(e as AclEntryRow)),
      effectiveRole: roleLabelForCapabilities(effectiveCapabilities),
      effectiveCapabilities,
    };
  }

  async setAcl(user: Principal, nodeId: string, dto: SetAclRequest): Promise<AclEntryDto> {
    const node = await this.nodeOr404(nodeId);
    await this.requireCapability(user, node.path, 'share');

    const target = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!target) throw new NotFoundException('Target user not found');

    const capabilities = normalizeCapabilities(
      dto.capabilities ?? capabilitiesForRole(dto.role ?? 'viewer'),
    );
    if (capabilities.length === 0) {
      throw new ForbiddenException('A grant must include at least one capability');
    }
    const role = roleLabelForCapabilities(capabilities);

    const entry = await this.prisma.aclEntry.upsert({
      where: { nodeId_userId: { nodeId, userId: dto.userId } },
      create: { nodeId, userId: dto.userId, role, capabilities },
      update: { role, capabilities },
      include: { user: { select: { email: true, displayName: true } } },
    });
    return toAclDto(entry as AclEntryRow);
  }

  async removeAcl(user: Principal, nodeId: string, targetUserId: string): Promise<void> {
    const node = await this.nodeOr404(nodeId);
    await this.requireCapability(user, node.path, 'share');
    await this.prisma.aclEntry.deleteMany({ where: { nodeId, userId: targetUserId } });
  }

  private async nodeOr404(id: string): Promise<PrismaNode> {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    return node;
  }
}
