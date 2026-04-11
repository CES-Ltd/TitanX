/**
 * @license Apache-2.0
 * Workspace isolation types — multi-tenant security boundary.
 * Every DB query, IPC call, and WebSocket broadcast is scoped to a workspace.
 */

/** Workspace record stored in the `workspaces` table */
export type Workspace = {
  id: string;
  name: string;
  ownerId: string;
  slug: string;
  /** Isolation mode: 'strict' enforces DB-level row isolation; 'soft' uses app-level filtering */
  isolationMode: WorkspaceIsolationMode;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** Member of a workspace with a specific role */
export type WorkspaceMember = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: number;
};

/** Isolation enforcement mode */
export type WorkspaceIsolationMode = 'strict' | 'soft';

/** Member roles within a workspace */
export type WorkspaceMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

/** Input for creating a new workspace */
export type CreateWorkspaceInput = {
  name: string;
  ownerId: string;
  isolationMode?: WorkspaceIsolationMode;
  metadata?: Record<string, unknown>;
};

/** Workspace context injected into every request/query for scoping */
export type WorkspaceContext = {
  workspaceId: string;
  userId: string;
  role: WorkspaceMemberRole;
};

/** Audit event when workspace isolation is breached or enforced */
export type WorkspaceIsolationEvent = {
  type: 'access_granted' | 'access_denied' | 'cross_workspace_blocked';
  workspaceId: string;
  actorId: string;
  targetEntity: string;
  targetEntityId?: string;
  reason: string;
  timestamp: number;
};
