import { UnauthorizedException } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuthService } from './auth.service';
import type { AuthProvider, ExternalIdentity } from './providers/auth-provider.interface';
import type { LoginDto } from './dto/login.dto';

const USER: User = {
  id: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  authSource: 'ldap',
  passwordHash: null,
  externalId: 'uid=alice,ou=people,dc=example,dc=org',
  isAdmin: false,
  createdAt: new Date(),
};

type AuthFn = AuthProvider['authenticate'];

function makeService(localFn: AuthFn, ldapFn: AuthFn, enabled = ['ldap', 'local']) {
  const local = { name: 'local', authenticate: localFn };
  const ldap = { name: 'ldap', authenticate: ldapFn };
  const authConfig = { getEnabledProviders: jest.fn(async () => enabled) };
  const users = { upsertFromIdentity: jest.fn(async () => USER) };
  const tokens = { issue: jest.fn(async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 })) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new AuthService(local as any, ldap as any, authConfig as any, users as any, tokens as any);
  return { svc, users, tokens, localFn, ldapFn };
}

const login = (over: Partial<LoginDto> = {}): LoginDto => ({
  username: 'alice',
  password: 'secret',
  ...over,
});

describe('AuthService', () => {
  it('falls back to the next provider when one throws (directory down)', async () => {
    const { svc, tokens } = makeService(
      async (): Promise<ExternalIdentity> => ({ source: 'local', email: 'alice@example.com', displayName: 'Alice' }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    const res = await svc.login(login());
    expect(res.user.email).toBe('alice@example.com');
    expect(tokens.issue).toHaveBeenCalledTimes(1);
  });

  it('returns tokens on the first successful provider', async () => {
    const { svc, users } = makeService(
      async () => null,
      async (): Promise<ExternalIdentity> => ({
        source: 'ldap',
        externalId: USER.externalId!,
        email: USER.email,
        displayName: USER.displayName,
      }),
    );
    const res = await svc.login(login());
    expect(res.tokens.accessToken).toBe('a');
    expect(users.upsertFromIdentity).toHaveBeenCalledTimes(1);
  });

  it('honours the provider hint', async () => {
    const localCalled = jest.fn(async () => null);
    const ldapCalled = jest.fn(async () => null);
    const { svc } = makeService(localCalled, ldapCalled);
    await expect(svc.login(login({ provider: 'local' }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ldapCalled).not.toHaveBeenCalled();
    expect(localCalled).toHaveBeenCalledTimes(1);
  });

  it('throws Unauthorized when every provider rejects the credentials', async () => {
    const { svc } = makeService(
      async () => null,
      async () => null,
    );
    await expect(svc.login(login())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
