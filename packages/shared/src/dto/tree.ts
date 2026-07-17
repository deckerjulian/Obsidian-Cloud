import type { NodeKind } from '../constants';
import type { Role } from '../roles';
import type { Capability } from '../capabilities';

/** Marks a folder with server-side special semantics. 'plugins': the central
 *  Obsidian plugin folder — synced to `.obsidian/plugins`, not into the vault. */
export type SystemFolderType = 'plugins';

/** A single node in the vault tree, as returned to a client. */
export interface TreeNodeDto {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  /** Materialized id-path: parent ids joined by '/' (root itself is ''). Reveals
   *  no names — the server never sees plaintext. NOT a human-readable path. */
  path: string;
  /** Stable document id (Yjs room / content + name key). Present for files AND
   *  folders (folder names are encrypted too); may be null only for legacy rows. */
  docId: string | null;
  isText: boolean;
  mime: string | null;
  depth: number;
  /** Non-null for system folders (see SystemFolderType). */
  systemType: SystemFolderType | null;
  /** The requesting user's effective role on this node (inherited, for display). */
  role: Role;
  /** The requesting user's effective fine-grained capabilities on this node. */
  capabilities: Capability[];
  updatedAt: string;
}

/** `GET /api/tree` — the subtree the user is allowed to see. */
export interface TreeResponse {
  nodes: TreeNodeDto[];
}

/** `POST /api/nodes` — create a folder or file. */
export interface CreateNodeRequest {
  parentId: string | null;
  kind: NodeKind;
  name: string;
  /** For files: whether it is a collaborative text note (default true). */
  isText?: boolean;
  mime?: string;
  /** Create a system folder (admin only; one per type; folder at the root). */
  systemType?: SystemFolderType;
}

/** `PATCH /api/nodes/:id` — rename and/or move. */
export interface UpdateNodeRequest {
  /** New name (rename). */
  name?: string;
  /** New parent id (move). `null` moves to the vault root. */
  parentId?: string | null;
}
