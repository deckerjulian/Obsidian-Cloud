import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { User } from '@prisma/client';
import type { TokenPair } from '@oc/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Issue a fresh access JWT + a new refresh token (optionally in an existing family). */
  async issue(user: User, familyId?: string): Promise<TokenPair> {
    const accessTtl = this.config.get<number>('jwt.accessTtl')!;
    const refreshTtl = this.config.get<number>('jwt.refreshTtl')!;

    const payload: AccessTokenPayload = { sub: user.id, email: user.email, isAdmin: user.isAdmin };
    const accessToken = await this.jwt.signAsync(payload);

    const raw = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId: familyId ?? randomUUID(),
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return { accessToken, refreshToken: raw, expiresIn: accessTtl };
  }

  /**
   * Rotate a refresh token. Detects reuse: if a token that was already rotated
   * (revoked) is presented again, the whole family is revoked (likely theft).
   */
  async rotate(raw: string): Promise<{ user: User; tokens: TokenPair }> {
    const tokenHash = sha256(raw);
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!row) throw new UnauthorizedException('Invalid refresh token');

    if (row.revoked) {
      // Reuse of an already-rotated token → revoke the entire family.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    await this.prisma.refreshToken.update({ where: { id: row.id }, data: { revoked: true } });
    const tokens = await this.issue(row.user, row.familyId);
    return { user: row.user, tokens };
  }

  /** Revoke a single refresh token (logout). */
  async revoke(raw: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(raw) },
      data: { revoked: true },
    });
  }
}
