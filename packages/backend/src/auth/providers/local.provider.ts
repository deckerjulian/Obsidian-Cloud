import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { verifyPassword } from '../password';
import type { AuthProvider, ExternalIdentity } from './auth-provider.interface';

/** Verifies username (= email) + password against the local Argon2 hash. */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';

  constructor(private readonly prisma: PrismaService) {}

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: username.trim().toLowerCase() },
    });
    if (!user || user.authSource !== 'local' || !user.passwordHash) return null;

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) return null;

    return {
      source: 'local',
      email: user.email,
      displayName: user.displayName,
      isAdmin: user.isAdmin,
    };
  }
}
