import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Node as PrismaNode } from '@prisma/client';
import {
  joinPath,
  depthOf,
  isAncestorOrSelf,
  roleLabelForCapabilities,
  capabilitiesForRole,
  ALL_CAPABILITIES,
  type Role,
  type Capability,
  type TreeNodeDto,
  type TreeResponse,
  type CreateNodeRequest,
  type UpdateNodeRequest,
} from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AclService, type Principal } from '../acl/acl.service';

function toTreeNodeDto(node: PrismaNode, capabilities: Capability[]): TreeNodeDto {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    name: node.name,
    path: node.path,
    docId: node.docId,
    isText: node.isText,
    mime: node.mime,
    depth: node.depth,
    systemType: (node.systemType as TreeNodeDto['systemType']) ?? null,
    role: roleLabelForCapabilities(capabilities),
    capabilities,
    updatedAt: node.updatedAt.toISOString(),
  };
}

function validateName(name: string): string {
  // The name is opaque ciphertext (E2EE); only require it to be non-empty.
  const n = name.trim();
  if (n.length === 0) throw new BadRequestException('Name must not be empty');
  return n;
}

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AclService,
  ) {}

  /**
   * Cheap global fingerprint of everything /tree depends on (nodes + grants).
   * Backs the ETag on GET /tree so 20-second polls short-circuit with 304
   * instead of recomputing per-user ACLs and shipping the whole tree.
   */
  async treeVersion(): Promise<string> {
    const [nodes, acl] = await Promise.all([
      this.prisma.node.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
      this.prisma.aclEntry.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    ]);
    return [
      nodes._count._all,
      nodes._max.updatedAt?.getTime() ?? 0,
      acl._count._all,
      acl._max.updatedAt?.getTime() ?? 0,
    ].join('.');
  }

  /** Ensure the single vault root node (path '') exists. */
  async ensureRoot(): Promise<PrismaNode> {
    const existing = await this.prisma.node.findUnique({ where: { path: '' } });
    if (existing) return existing;
    return this.prisma.node.create({
      data: { parentId: null, kind: 'folder', name: '', path: '', depth: 0 },
    });
  }

  /** Return every node the user may read, each with its effective capabilities. */
  async getTree(user: Principal): Promise<TreeResponse> {
    const all = await this.prisma.node.findMany({ orderBy: { path: 'asc' } });

    // Admins have full rights everywhere, including the central plugin folder.
    if (user.isAdmin) {
      return { nodes: all.map((n) => toTreeNodeDto(n, [...ALL_CAPABILITIES])) };
    }

    const grants = await this.prisma.aclEntry.findMany({
      where: { userId: user.userId },
      select: { role: true, capabilities: true, node: { select: { path: true, depth: true } } },
    });

    const nodes: TreeNodeDto[] = [];
    const included = new Set<string>();
    for (const n of all) {
      let bestDepth = -1;
      const caps = new Set<Capability>();
      for (const g of grants) {
        if (!isAncestorOrSelf(g.node.path, n.path)) continue;
        const rc = g.capabilities.length
          ? (g.capabilities as Capability[])
          : capabilitiesForRole(g.role as Role);
        if (g.node.depth > bestDepth) {
          bestDepth = g.node.depth;
          caps.clear();
          rc.forEach((c) => caps.add(c));
        } else if (g.node.depth === bestDepth) {
          rc.forEach((c) => caps.add(c));
        }
      }
      if (caps.size > 0) {
        nodes.push(toTreeNodeDto(n, [...caps]));
        included.add(n.id);
      }
    }

    // The central plugin folder is auto-distributed: every user gets read on it
    // and its subtree (so the Obsidian plugin can download the managed plugins).
    // The web hides it from non-admins; the plugin still receives it.
    const pluginsRoot = all.find((n) => n.systemType === 'plugins');
    if (pluginsRoot) {
      const prefix = `${pluginsRoot.path}/`;
      for (const n of all) {
        if (included.has(n.id)) continue;
        if (n.id === pluginsRoot.id || n.path.startsWith(prefix)) {
          nodes.push(toTreeNodeDto(n, ['read']));
        }
      }
    }
    return { nodes };
  }

  async create(user: Principal, dto: CreateNodeRequest): Promise<TreeNodeDto> {
    // System folders (e.g. the central plugin folder) are admin-created,
    // top-level, and unique per type.
    if (dto.systemType) {
      if (!user.isAdmin) {
        throw new ForbiddenException('Only admins can create system folders');
      }
      if (dto.kind !== 'folder' || dto.parentId !== null) {
        throw new BadRequestException('A system folder must be a folder at the vault root');
      }
      const existing = await this.prisma.node.findFirst({
        where: { systemType: dto.systemType },
      });
      if (existing) throw new ConflictException('This system folder already exists');
    }

    const parent = await this.resolveParent(dto.parentId);
    if (parent.kind !== 'folder') throw new BadRequestException('Parent must be a folder');
    await this.acl.requireCapability(user, parent.path, 'create');

    const name = validateName(dto.name); // ciphertext; .md enforcement happens client-side
    const isFile = dto.kind === 'file';
    const isText = isFile ? (dto.isText ?? true) : false;
    // Materialized path is an id-chain (reveals no names); generate the id up
    // front so we can build it. Every node (folder + file) gets a docId so its
    // name and content can be E2EE-keyed.
    const id = randomUUID();
    const path = joinPath(parent.path, id);

    try {
      const node = await this.prisma.node.create({
        data: {
          id,
          parentId: parent.id,
          kind: dto.kind,
          name,
          path,
          depth: parent.depth + 1,
          docId: randomUUID(),
          isText,
          mime: dto.mime ?? null,
          systemType: dto.systemType ?? null,
        },
      });
      const caps = (await this.acl.effectiveCapabilities(user, path)) ?? capabilitiesForRole('editor');
      return toTreeNodeDto(node, caps);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async update(user: Principal, id: string, dto: UpdateNodeRequest): Promise<TreeNodeDto> {
    const node = await this.nodeOr404(id);
    if (node.path === '') throw new BadRequestException('Cannot modify the root');
    // System folders are shared with regular users (that's their point), but
    // only admins may rename them — and nobody may move them off the root:
    // clients locate them by systemType and rely on the top-level invariant.
    if (node.systemType) {
      if (!user.isAdmin) throw new ForbiddenException('Only admins can modify system folders');
      if (dto.parentId !== undefined && dto.parentId !== node.parentId) {
        throw new BadRequestException('System folders cannot be moved');
      }
    }
    await this.acl.requireCapability(user, node.path, 'edit');

    const name = dto.name !== undefined ? validateName(dto.name) : node.name;
    const moving = dto.parentId !== undefined && dto.parentId !== node.parentId;

    // Rename only: the id-path is stable, so just replace the (ciphertext) name.
    if (!moving) {
      const updated = await this.prisma.node.update({ where: { id: node.id }, data: { name } });
      const caps =
        (await this.acl.effectiveCapabilities(user, node.path)) ?? capabilitiesForRole('editor');
      return toTreeNodeDto(updated, caps);
    }

    const parent = await this.resolveParent(dto.parentId!);
    if (parent.kind !== 'folder') throw new BadRequestException('Target must be a folder');
    await this.acl.requireCapability(user, parent.path, 'create');
    if (isAncestorOrSelf(node.path, parent.path)) {
      throw new BadRequestException('Cannot move a node into itself');
    }
    const newPath = joinPath(parent.path, node.id);
    const newDepth = parent.depth + 1;

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const oldPrefix = `${node.path}/`;
        const descendants = await tx.node.findMany({ where: { path: { startsWith: oldPrefix } } });

        const self = await tx.node.update({
          where: { id: node.id },
          data: { name, parentId: parent.id, path: newPath, depth: newDepth },
        });

        for (const d of descendants) {
          const rel = d.path.slice(node.path.length); // includes leading '/'
          const childPath = `${newPath}${rel}`;
          await tx.node.update({
            where: { id: d.id },
            data: { path: childPath, depth: depthOf(childPath) },
          });
        }
        return self;
      });

      const caps =
        (await this.acl.effectiveCapabilities(user, newPath)) ?? capabilitiesForRole('editor');
      return toTreeNodeDto(updated, caps);
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async remove(user: Principal, id: string): Promise<void> {
    const node = await this.nodeOr404(id);
    if (node.path === '') throw new BadRequestException('Cannot delete the root');
    // Deleting a system folder cascades away every member's plugin files and
    // wrapped keys — admin-only, mirroring the create() gate.
    if (node.systemType && !user.isAdmin) {
      throw new ForbiddenException('Only admins can delete system folders');
    }
    await this.acl.requireCapability(user, node.path, 'delete');
    await this.prisma.node.delete({ where: { id } }); // cascades to children/acl/document/blob
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async resolveParent(parentId: string | null): Promise<PrismaNode> {
    if (parentId === null) return this.ensureRoot();
    return this.nodeOr404(parentId);
  }

  private async nodeOr404(id: string): Promise<PrismaNode> {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    return node;
  }

  private mapWriteError(err: unknown): Error {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException('A node with that name already exists here');
    }
    return err as Error;
  }
}
