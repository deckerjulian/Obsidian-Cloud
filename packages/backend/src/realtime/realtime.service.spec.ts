import { WS_DOC_PATH } from '@oc/shared';
import { RealtimeService } from './realtime.service';

function makeService() {
  const jwt = { verifyAsync: jest.fn() };
  const acl = { effectiveCapabilities: jest.fn() };
  const prisma = { node: { findUnique: jest.fn() } };
  const config = { get: () => 'secret' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new RealtimeService({} as any, jwt as any, acl as any, prisma as any, config as any);
  // authorize is private; reach it for testing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authorize = (svc as any).authorize.bind(svc) as (
    url: URL,
  ) => Promise<{ docId: string; readOnly: boolean } | null>;
  return { authorize, jwt, acl, prisma };
}

const url = (docId = 'doc-1', token = 'tok') => new URL(`http://x${WS_DOC_PATH}/${docId}?token=${token}`);

describe('RealtimeService relay authorization', () => {
  it('authorizes an editor with write access', async () => {
    const { authorize, jwt, acl, prisma } = makeService();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', isAdmin: false });
    prisma.node.findUnique.mockResolvedValue({ path: 'a', docId: 'doc-1' });
    acl.effectiveCapabilities.mockResolvedValue(['read', 'create', 'edit', 'delete']);
    expect(await authorize(url())).toMatchObject({ docId: 'doc-1', readOnly: false, userId: 'u1' });
  });

  it('marks a viewer read-only', async () => {
    const { authorize, jwt, acl, prisma } = makeService();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u2', isAdmin: false });
    prisma.node.findUnique.mockResolvedValue({ path: 'a', docId: 'doc-1' });
    acl.effectiveCapabilities.mockResolvedValue(['read']);
    expect(await authorize(url())).toMatchObject({ docId: 'doc-1', readOnly: true, userId: 'u2' });
  });

  it('rejects an invalid token', async () => {
    const { authorize, jwt } = makeService();
    jwt.verifyAsync.mockRejectedValue(new Error('bad token'));
    expect(await authorize(url())).toBeNull();
  });

  it('rejects an unknown document', async () => {
    const { authorize, jwt, prisma } = makeService();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', isAdmin: false });
    prisma.node.findUnique.mockResolvedValue(null);
    expect(await authorize(url())).toBeNull();
  });

  it('rejects a user without read access', async () => {
    const { authorize, jwt, acl, prisma } = makeService();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', isAdmin: false });
    prisma.node.findUnique.mockResolvedValue({ path: 'a', docId: 'doc-1' });
    acl.effectiveCapabilities.mockResolvedValue(null);
    expect(await authorize(url())).toBeNull();
  });
});
