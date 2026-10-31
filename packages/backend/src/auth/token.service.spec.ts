import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';

interface Row {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  revoked: boolean;
  expiresAt: Date;
}

const USER: User = {
  id: 'u1',
  email: 'admin@example.com',
  displayName: 'Admin',
  authSource: 'local',
  passwordHash: 'x',
  externalId: null,
  isAdmin: true,
  isPluginAdmin: false,
  createdAt: new Date(),
};

/** Minimal in-memory stand-in for the Prisma calls TokenService uses. */
class FakePrisma {
  rows: Row[] = [];
  private seq = 0;

  refreshToken = {
    create: async ({ data }: { data: Omit<Row, 'id' | 'revoked'> }) => {
      const row: Row = { id: `rt_${++this.seq}`, revoked: false, ...data };
      this.rows.push(row);
      return row;
    },
    findUnique: async ({
      where: { tokenHash },
      include,
    }: {
      where: { tokenHash: string };
      include?: { user?: boolean };
    }) => {
      const row = this.rows.find((r) => r.tokenHash === tokenHash);
      if (!row) return null;
      return include?.user ? { ...row, user: USER } : row;
    },
    update: async ({ where: { id }, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = this.rows.find((r) => r.id === id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { familyId?: string; tokenHash?: string };
      data: Partial<Row>;
    }) => {
      let count = 0;
      for (const r of this.rows) {
        if (
          (where.familyId && r.familyId === where.familyId) ||
          (where.tokenHash && r.tokenHash === where.tokenHash)
        ) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
  };
}

function makeService() {
  const prisma = new FakePrisma();
  const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: 900 } });
  const config = {
    get: (key: string) => ({ 'jwt.accessTtl': 900, 'jwt.refreshTtl': 3600 })[key],
  } as unknown as ConfigService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new TokenService(jwt, prisma as any, config);
  return { svc, prisma, jwt };
}

describe('TokenService', () => {
  it('issues an access JWT and a refresh token', async () => {
    const { svc, prisma, jwt } = makeService();
    const tokens = await svc.issue(USER);

    expect(tokens.expiresIn).toBe(900);
    expect(tokens.refreshToken).toBeTruthy();
    expect(prisma.rows).toHaveLength(1);

    const decoded = jwt.verify(tokens.accessToken) as { sub: string; isAdmin: boolean };
    expect(decoded.sub).toBe('u1');
    expect(decoded.isAdmin).toBe(true);
  });

  it('rotates a refresh token and revokes the old one', async () => {
    const { svc, prisma } = makeService();
    const first = await svc.issue(USER);

    const { tokens: second } = await svc.rotate(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(prisma.rows).toHaveLength(2);
    // old token row revoked, new one active, same family
    expect(prisma.rows[0].revoked).toBe(true);
    expect(prisma.rows[1].revoked).toBe(false);
    expect(prisma.rows[1].familyId).toBe(prisma.rows[0].familyId);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const { svc, prisma } = makeService();
    const first = await svc.issue(USER);
    await svc.rotate(first.refreshToken); // first is now revoked

    await expect(svc.rotate(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);

    // every token in the family must now be revoked
    expect(prisma.rows.every((r) => r.revoked)).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    const { svc } = makeService();
    await expect(svc.rotate('not-a-real-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
