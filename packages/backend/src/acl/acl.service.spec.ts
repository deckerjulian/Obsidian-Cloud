import type { Role } from '@oc/shared';
import { AclService } from './acl.service';

interface Grant {
  path: string;
  depth: number;
  role: Role;
}

/** Mocks prisma.aclEntry.findMany, honouring the ancestor `path IN (...)` filter.
 *  `configPaths`: folders flagged as a vault config folder (`.obsidian`). */
function makeService(grants: Grant[], configPaths: string[] = [], pluginAdmins: string[] = []) {
  const prisma = {
    node: {
      findFirst: async ({ where }: { where: { path: { in: string[] } } }) =>
        configPaths.find((p) => where.path.in.includes(p)) ? { id: 'cfg' } : null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ isPluginAdmin: pluginAdmins.includes(where.id) }),
    },
    aclEntry: {
      findMany: async ({ where }: { where: { node: { path: { in: string[] } } } }) => {
        const paths = where.node.path.in;
        return grants
          .filter((g) => paths.includes(g.path))
          .map((g) => ({ role: g.role, capabilities: [], node: { depth: g.depth } }));
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AclService(prisma as any);
}

describe('AclService.effectiveRole', () => {
  const user = { userId: 'u1', isAdmin: false };

  it('makes admins owners everywhere without querying', async () => {
    const svc = makeService([]);
    expect(await svc.effectiveRole({ userId: 'a', isAdmin: true }, 'some/deep/path')).toBe('owner');
  });

  it('lets the nearest ancestor grant win', async () => {
    const svc = makeService([
      { path: '', depth: 0, role: 'viewer' },
      { path: 'a', depth: 1, role: 'editor' },
    ]);
    expect(await svc.effectiveRole(user, 'a/b/c')).toBe('editor');
    expect(await svc.effectiveRole(user, 'x')).toBe('viewer'); // only the root grant applies
  });

  it('returns null when no ancestor is granted', async () => {
    const svc = makeService([{ path: 'a', depth: 1, role: 'editor' }]);
    expect(await svc.effectiveRole(user, 'b')).toBeNull();
  });

  it('breaks depth ties with the stronger role', async () => {
    const svc = makeService([
      { path: 'a', depth: 1, role: 'viewer' },
      { path: 'a', depth: 1, role: 'owner' },
    ]);
    expect(await svc.effectiveRole(user, 'a/b')).toBe('owner');
  });
});

describe('AclService: vault config folder', () => {
  const grants: Grant[] = [{ path: 'v', depth: 1, role: 'owner' }];

  it('leaves only read inside the config folder for regular users', async () => {
    const svc = makeService(grants, ['v/cfg']);
    expect(await svc.effectiveCapabilities({ userId: 'u1', isAdmin: false }, 'v/cfg/plugin/main')).toEqual(['read']);
    expect(await svc.effectiveCapabilities({ userId: 'u1', isAdmin: false }, 'v/cfg')).toEqual(['read']);
    // Outside the config folder the vault grant applies unchanged.
    expect(await svc.effectiveCapabilities({ userId: 'u1', isAdmin: false }, 'v/notes')).toContain('edit');
  });

  it('keeps the grant for plugin admins and admins', async () => {
    const svc = makeService(grants, ['v/cfg'], ['pa']);
    expect(await svc.effectiveCapabilities({ userId: 'pa', isAdmin: false }, 'v/cfg/x')).toContain('edit');
    expect(await svc.effectiveCapabilities({ userId: 'adm', isAdmin: true }, 'v/cfg/x')).toContain('edit');
  });
});
