import type { Role } from '../roles';
import type { Capability } from '../capabilities';

/** A single explicit permission grant on a node. */
export interface AclEntryDto {
  id: string;
  nodeId: string;
  userId: string;
  /** Closest preset label for display. */
  role: Role;
  /** The authoritative fine-grained capabilities of this grant. */
  capabilities: Capability[];
  /** Convenience subject info for display. */
  user?: {
    email: string;
    displayName: string;
  };
}

/** `GET /api/nodes/:id/acl`. */
export interface AclListResponse {
  /** Explicit grants placed directly on this node. */
  entries: AclEntryDto[];
  /** The effective (possibly inherited) role of the requesting user. */
  effectiveRole: Role;
  /** The effective (possibly inherited) capabilities of the requesting user. */
  effectiveCapabilities: Capability[];
}

/**
 * `PUT /api/nodes/:id/acl` — grant/update a user's access on a node.
 * Provide `capabilities` for fine-grained control, or `role` for a preset.
 */
export interface SetAclRequest {
  userId: string;
  role?: Role;
  capabilities?: Capability[];
}
