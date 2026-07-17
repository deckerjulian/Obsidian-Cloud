import type { Role } from './roles';

/**
 * Fine-grained permissions a grant can carry on a folder/file:
 *  - read   : view the folder/file and its contents
 *  - create : create new children inside a folder
 *  - edit   : modify note content and rename/move
 *  - delete : delete the folder/file
 *  - share  : manage who else has access (ACL)
 */
export const CAPABILITIES = ['read', 'create', 'edit', 'delete', 'share'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Preset roles expand to capability sets. */
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  viewer: ['read'],
  editor: ['read', 'create', 'edit', 'delete'],
  owner: ['read', 'create', 'edit', 'delete', 'share'],
};

export function capabilitiesForRole(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export function hasCapability(caps: Capability[] | null | undefined, cap: Capability): boolean {
  return Array.isArray(caps) && caps.includes(cap);
}

/** Closest enum role label for a capability set (for display; never 'custom'). */
export function roleLabelForCapabilities(caps: Capability[]): Role {
  if (caps.includes('share')) return 'owner';
  if (caps.includes('create') || caps.includes('edit') || caps.includes('delete')) return 'editor';
  return 'viewer';
}

/** Whether a capability set exactly matches a named preset (for UI highlighting). */
export function matchesRolePreset(caps: Capability[], role: Role): boolean {
  const preset = ROLE_CAPABILITIES[role];
  return preset.length === caps.length && preset.every((c) => caps.includes(c));
}

export const ALL_CAPABILITIES: Capability[] = [...CAPABILITIES];
