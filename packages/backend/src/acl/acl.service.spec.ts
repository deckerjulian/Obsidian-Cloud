import type { Role } from '@oc/shared';
import { AclService } from './acl.service';

interface Grant {
  path: string;
  depth: number;
  role: Role;
}

/** Mocks prisma.aclEntry.findMany, honouring the ancestor `path IN (...)` filter. */
function makeService(grants: Grant[]) {
  const prisma = {
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
