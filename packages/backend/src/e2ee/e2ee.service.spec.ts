import { ForbiddenException } from '@nestjs/common';
import type { Capability } from '@oc/shared';
import { E2eeService } from './e2ee.service';

/**
 * Focused on the authorization of setDocumentKeys: keying a document for
 * another user is allowed WITHOUT 'share' only when that user already has read
 * access (fan-out of a note created in a shared folder), and rejected otherwise.
 */
function makeService(opts: {
  callerCaps: Capability[];
  // userId -> effective caps at the node path (undefined = no access)
  targetCaps: Record<string, Capability[] | undefined>;
}) {
  const node = { path: 'a/b', docId: 'doc-1' };
  const upserts: Array<{ userId: string }> = [];
  const prisma = {
    node: { findUnique: async () => node },
    documentKey: {
      upsert: (args: { where: { docId_userId: { userId: string } } }) => {
        upserts.push({ userId: args.where.docId_userId.userId });
        return args;
      },
    },
    $transaction: async (ops: unknown[]) => ops,
  };
  const acl = {
    requireCapability: async (_u: unknown, _p: string, cap: Capability) => {
      if (!opts.callerCaps.includes(cap)) throw new ForbiddenException(`needs ${cap}`);
      return opts.callerCaps;
    },
    // Everyone (grantee or admin) whose caps include read is an entitled reader.
    effectiveReaders: async () =>
      Object.entries(opts.targetCaps)
        .filter(([, caps]) => caps?.includes('read'))
        .map(([id]) => id),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new E2eeService(prisma as any, acl as any);
  return { svc, upserts };
}

describe('E2eeService.setDocumentKeys authorization', () => {
  const caller = { userId: 'me', isAdmin: false };
  const entry = (userId: string) => ({ userId, wrappedKey: 'w' });

  it('lets a reader key a document for themselves', async () => {
    const { svc, upserts } = makeService({ callerCaps: ['read'], targetCaps: {} });
    await svc.setDocumentKeys(caller, 'doc-1', { entries: [entry('me')] });
    expect(upserts.map((u) => u.userId)).toEqual(['me']);
  });

  it('keys for another user who already has read access, without share', async () => {
    const { svc, upserts } = makeService({
      callerCaps: ['read', 'create'], // no 'share'
      targetCaps: { bob: ['read'] },
    });
    await svc.setDocumentKeys(caller, 'doc-1', { entries: [entry('bob')] });
    expect(upserts.map((u) => u.userId)).toEqual(['bob']);
  });

  it('rejects keying for a user without access when the caller cannot share', async () => {
    const { svc } = makeService({
      callerCaps: ['read', 'create'],
      targetCaps: { mallory: undefined }, // no access
    });
    await expect(
      svc.setDocumentKeys(caller, 'doc-1', { entries: [entry('mallory')] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keys for an admin (always an entitled reader) without share', async () => {
    const { svc, upserts } = makeService({
      callerCaps: ['read'], // plain reader, no create/share
      targetCaps: { adminUser: ['read'] }, // effectiveReaders includes admins
    });
    await svc.setDocumentKeys(caller, 'doc-1', { entries: [entry('adminUser')] });
    expect(upserts.map((u) => u.userId)).toEqual(['adminUser']);
  });

  it('allows a sharer to key for anyone', async () => {
    const { svc, upserts } = makeService({
      callerCaps: ['read', 'share'],
      targetCaps: { newuser: undefined },
    });
    await svc.setDocumentKeys(caller, 'doc-1', { entries: [entry('newuser')] });
    expect(upserts.map((u) => u.userId)).toEqual(['newuser']);
  });
});
