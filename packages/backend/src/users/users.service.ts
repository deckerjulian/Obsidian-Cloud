import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { UserDto, CreateUserRequest, UpdateUserRequest } from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from '../auth/password';
import type { ExternalIdentity } from '../auth/providers/auth-provider.interface';

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    isPluginAdmin: user.isPluginAdmin,
    authSource: user.authSource,
  };
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  count(): Promise<number> {
    return this.prisma.user.count();
  }

  async getById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** All users (used to pick share targets). */
  list(): Promise<User[]> {
    return this.prisma.user.findMany({ orderBy: { displayName: 'asc' } });
  }

  /** Admin: create a local (password) account. */
  async createLocal(input: CreateUserRequest): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('A user with that email already exists');

    return this.prisma.user.create({
      data: {
        email,
        displayName: input.displayName,
        authSource: 'local',
        passwordHash: await hashPassword(input.password),
        isAdmin: input.isAdmin ?? false,
        isPluginAdmin: input.isPluginAdmin ?? false,
      },
    });
  }

  /** Admin: update a user. A `password` resets a local account's password. */
  async update(id: string, dto: UpdateUserRequest): Promise<User> {
    const user = await this.getById(id);
    const data: { displayName?: string; isAdmin?: boolean; isPluginAdmin?: boolean; passwordHash?: string } = {};
    if (dto.isPluginAdmin !== undefined) data.isPluginAdmin = dto.isPluginAdmin;
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.isAdmin !== undefined) {
      // An instance without any admin is unrecoverable from the UI.
      if (user.isAdmin && !dto.isAdmin) {
        const admins = await this.prisma.user.count({ where: { isAdmin: true } });
        if (admins <= 1) throw new BadRequestException('Cannot demote the last admin');
      }
      data.isAdmin = dto.isAdmin;
    }
    if (dto.password) {
      if (user.authSource !== 'local') {
        throw new BadRequestException('Password applies to local accounts only');
      }
      data.passwordHash = await hashPassword(dto.password);
    }
    return this.prisma.user.update({ where: { id }, data });
  }

  /** Admin: delete a user (cascades to ACL grants and refresh tokens). */
  async remove(id: string, requesterId: string): Promise<void> {
    if (id === requesterId) throw new BadRequestException('You cannot delete your own account');
    await this.getById(id);
    await this.prisma.user.delete({ where: { id } });
  }

  /** Self-service: change your own local password. */
  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.getById(userId);
    if (user.authSource !== 'local' || !user.passwordHash) {
      throw new BadRequestException('Your password is managed by your directory');
    }
    if (!(await verifyPassword(user.passwordHash, current))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(next) },
    });
  }

  /**
   * Resolve (and for directory accounts, just-in-time provision) the User behind
   * a verified identity. Local identities already correspond to a row.
   */
  async upsertFromIdentity(identity: ExternalIdentity): Promise<User> {
    if (identity.source === 'local') {
      const user = await this.prisma.user.findUnique({ where: { email: identity.email.toLowerCase() } });
      if (!user) throw new NotFoundException('User not found');
      return user;
    }

    // LDAP/AD: match by stable externalId first, then link/create by email.
    if (identity.externalId) {
      const byExternal = await this.prisma.user.findUnique({
        where: { externalId: identity.externalId },
      });
      if (byExternal) {
        return this.prisma.user.update({
          where: { id: byExternal.id },
          data: {
            email: identity.email.toLowerCase(),
            displayName: identity.displayName,
            isAdmin: identity.isAdmin ?? byExternal.isAdmin,
          },
        });
      }
    }

    const email = identity.email.toLowerCase();
    const byEmail = await this.prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      // Never silently merge a directory identity into an existing account of
      // a DIFFERENT auth source: it would flip authSource (locking out local
      // login), overwrite the admin flag from LDAP group membership, and hand
      // whoever controls that directory email an account takeover.
      if (byEmail.authSource !== 'ldap') {
        throw new UnauthorizedException(
          'An account with this email already exists with a different sign-in method',
        );
      }
      return this.prisma.user.update({
        where: { id: byEmail.id },
        data: {
          externalId: identity.externalId ?? byEmail.externalId,
          displayName: identity.displayName,
          isAdmin: identity.isAdmin ?? byEmail.isAdmin,
        },
      });
    }

    return this.prisma.user.create({
      data: {
        email,
        displayName: identity.displayName,
        authSource: 'ldap',
        externalId: identity.externalId ?? null,
        isAdmin: identity.isAdmin ?? false,
      },
    });
  }
}
