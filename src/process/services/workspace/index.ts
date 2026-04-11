/**
 * @license Apache-2.0
 * Workspace service — multi-tenant isolation boundary.
 * Creates, manages, and enforces workspace boundaries at the data layer.
 *
 * Security: Every tenant-scoped query flows through workspace context validation.
 * Blast radius: A compromised agent in workspace A cannot access workspace B data.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type {
  Workspace,
  WorkspaceMember,
  CreateWorkspaceInput,
  WorkspaceContext,
  WorkspaceMemberRole,
} from '@/common/types/workspaceTypes';

// ── Workspace CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new workspace. The creator becomes the owner automatically.
 */
export function createWorkspace(db: ISqliteDriver, input: CreateWorkspaceInput): Workspace {
  const id = crypto.randomUUID();
  const now = Date.now();
  const slug = slugify(input.name);
  const isolationMode = input.isolationMode ?? 'strict';
  const metadata = JSON.stringify(input.metadata ?? {});

  db.prepare(
    `INSERT INTO workspaces (id, name, owner_id, slug, isolation_mode, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.name, input.ownerId, slug, isolationMode, metadata, now, now);

  // Auto-add owner as member
  addMember(db, id, input.ownerId, 'owner');

  console.log(`[Workspace] Created workspace "${input.name}" (${id}) for user ${input.ownerId}`);

  return {
    id,
    name: input.name,
    ownerId: input.ownerId,
    slug,
    isolationMode,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get a workspace by ID. Returns null if not found.
 */
export function getWorkspace(db: ISqliteDriver, workspaceId: string): Workspace | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return rowToWorkspace(row);
}

/**
 * List workspaces the user is a member of.
 */
export function listWorkspacesForUser(db: ISqliteDriver, userId: string): Workspace[] {
  const rows = db
    .prepare(
      `SELECT w.* FROM workspaces w
       INNER JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = ?
       ORDER BY w.updated_at DESC`
    )
    .all(userId) as Array<Record<string, unknown>>;

  return rows.map(rowToWorkspace);
}

/**
 * Delete a workspace and all its members. Only the owner can delete.
 */
export function deleteWorkspace(db: ISqliteDriver, workspaceId: string, actorId: string): void {
  const ws = getWorkspace(db, workspaceId);
  if (!ws) throw new Error(`Workspace ${workspaceId} not found`);
  if (ws.ownerId !== actorId) throw new Error('Only the workspace owner can delete it');

  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(workspaceId);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
  console.log(`[Workspace] Deleted workspace ${workspaceId}`);
}

// ── Membership ──────────────────────────────────────────────────────────────

/**
 * Add a user as a member of a workspace.
 */
export function addMember(
  db: ISqliteDriver,
  workspaceId: string,
  userId: string,
  role: WorkspaceMemberRole
): WorkspaceMember {
  const id = crypto.randomUUID();
  const joinedAt = Date.now();

  db.prepare(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, workspaceId, userId, role, joinedAt);

  return { id, workspaceId, userId, role, joinedAt };
}

/**
 * Remove a member from a workspace. Owner cannot be removed.
 */
export function removeMember(db: ISqliteDriver, workspaceId: string, userId: string): void {
  const ws = getWorkspace(db, workspaceId);
  if (ws?.ownerId === userId) throw new Error('Cannot remove the workspace owner');

  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
}

/**
 * List all members of a workspace.
 */
export function listMembers(db: ISqliteDriver, workspaceId: string): WorkspaceMember[] {
  const rows = db
    .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? ORDER BY joined_at')
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    userId: r.user_id as string,
    role: r.role as WorkspaceMemberRole,
    joinedAt: r.joined_at as number,
  }));
}

// ── Workspace Context Resolution ────────────────────────────────────────────

/**
 * Resolve workspace context for a user. Returns null if user has no access.
 * This is the primary entry point for workspace-scoped operations.
 */
export function resolveContext(db: ISqliteDriver, workspaceId: string, userId: string): WorkspaceContext | null {
  const row = db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, userId) as { role: string } | undefined;

  if (!row) return null;

  return {
    workspaceId,
    userId,
    role: row.role as WorkspaceMemberRole,
  };
}

/**
 * Assert that a user has access to a workspace. Throws if denied.
 */
export function assertAccess(db: ISqliteDriver, workspaceId: string, userId: string): WorkspaceContext {
  const ctx = resolveContext(db, workspaceId, userId);
  if (!ctx) {
    throw new Error(`Access denied: user ${userId} is not a member of workspace ${workspaceId}`);
  }
  return ctx;
}

/**
 * Get the default workspace for a user (first one they own, or first they're a member of).
 */
export function getDefaultWorkspace(db: ISqliteDriver, userId: string): Workspace | null {
  // Prefer owned workspace
  const owned = db.prepare('SELECT * FROM workspaces WHERE owner_id = ? ORDER BY created_at LIMIT 1').get(userId) as
    | Record<string, unknown>
    | undefined;

  if (owned) return rowToWorkspace(owned);

  // Fall back to any membership
  const member = db
    .prepare(
      `SELECT w.* FROM workspaces w
       INNER JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = ?
       ORDER BY wm.joined_at LIMIT 1`
    )
    .get(userId) as Record<string, unknown> | undefined;

  return member ? rowToWorkspace(member) : null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function rowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: row.id as string,
    name: row.name as string,
    ownerId: row.owner_id as string,
    slug: row.slug as string,
    isolationMode: (row.isolation_mode as 'strict' | 'soft') ?? 'strict',
    metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
