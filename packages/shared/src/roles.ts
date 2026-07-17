/**
 * The permission roles a user can hold on a tree node. Roles are ranked and
 * inherited down the folder tree; the nearest explicit grant to a node wins.
 */
export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when `role` is at least as powerful as `min`. */
export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Can see the document/folder. */
export const canRead = (role: Role | null | undefined): boolean => roleAtLeast(role, 'viewer');
/** Can modify content and create/rename/delete children. */
export const canWrite = (role: Role | null | undefined): boolean => roleAtLeast(role, 'editor');
/** Can manage sharing / ACLs. */
export const canManage = (role: Role | null | undefined): boolean => roleAtLeast(role, 'owner');

/** Returns the stronger of two (possibly absent) roles. */
export function maxRole(a: Role | null | undefined, b: Role | null | undefined): Role | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}
