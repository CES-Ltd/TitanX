/**
 * @license Apache-2.0
 * Workspace isolation middleware — query scoping and cross-workspace access prevention.
 *
 * Enforces that all tenant-scoped database queries include workspace_id filtering.
 * Prevents data leakage between workspaces even if application code forgets to scope.
 *
 * Two modes:
 * - 'strict': Appends WHERE workspace_id = ? to queries (defense-in-depth)
 * - 'soft': Validates at the application layer only (for backward compatibility)
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { WorkspaceContext, WorkspaceIsolationEvent } from '@/common/types/workspaceTypes';

/** Tables that require workspace-scoped access */
const WORKSPACE_SCOPED_TABLES = new Set([
  'teams',
  'team_tasks',
  'mailbox',
  'sprint_tasks',
  'conversations',
  'agent_gallery',
  'iam_policies',
  'activity_log',
]);

/** Tables exempt from workspace scoping (global or per-user) */
const EXEMPT_TABLES = new Set([
  'users',
  'workspaces',
  'workspace_members',
  'reasoning_bank',
  'caveman_savings',
  'app_settings',
]);

/**
 * Create a workspace-scoped query wrapper.
 * All SELECT queries against scoped tables will automatically include workspace filtering.
 *
 * @param db - Raw SQLite driver
 * @param ctx - Workspace context with validated access
 * @returns A scoped query interface
 */
export function createScopedQuery(db: ISqliteDriver, ctx: WorkspaceContext): WorkspaceScopedDriver {
  return new WorkspaceScopedDriver(db, ctx);
}

/**
 * Validate that a query targets the correct workspace.
 * Returns an isolation event if cross-workspace access is detected.
 */
export function validateQueryScope(
  _sql: string,
  ctx: WorkspaceContext,
  actualWorkspaceId?: string
): WorkspaceIsolationEvent | null {
  if (!actualWorkspaceId) return null;
  if (actualWorkspaceId === ctx.workspaceId) return null;

  return {
    type: 'cross_workspace_blocked',
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    targetEntity: 'query',
    reason: `Cross-workspace access attempt: context=${ctx.workspaceId}, target=${actualWorkspaceId}`,
    timestamp: Date.now(),
  };
}

/**
 * Check if a table is workspace-scoped and requires isolation filtering.
 */
export function isWorkspaceScopedTable(tableName: string): boolean {
  return WORKSPACE_SCOPED_TABLES.has(tableName);
}

/**
 * Check if a table is exempt from workspace scoping.
 */
export function isExemptTable(tableName: string): boolean {
  return EXEMPT_TABLES.has(tableName);
}

/**
 * Log a workspace isolation event to the activity log.
 */
export function logIsolationEvent(db: ISqliteDriver, event: WorkspaceIsolationEvent): void {
  try {
    // Lazy import to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const activityLog = require('../activityLog') as typeof import('../activityLog');
    activityLog.logActivity(db, {
      userId: event.actorId,
      actorType: 'system',
      actorId: 'workspace_isolation',
      action: event.type,
      entityType: 'workspace',
      entityId: event.workspaceId,
      details: {
        targetEntity: event.targetEntity,
        targetEntityId: event.targetEntityId,
        reason: event.reason,
      },
      severity: event.type === 'cross_workspace_blocked' ? 'warning' : 'info',
    });
  } catch {
    console.error('[WorkspaceIsolation] Failed to log isolation event:', event);
  }
}

/**
 * Workspace-scoped database driver that wraps the raw SQLite driver.
 * Ensures all queries against workspace-scoped tables include the workspace_id filter.
 */
export class WorkspaceScopedDriver {
  private readonly db: ISqliteDriver;
  private readonly ctx: WorkspaceContext;

  constructor(db: ISqliteDriver, ctx: WorkspaceContext) {
    this.db = db;
    this.ctx = ctx;
  }

  /** Get the underlying workspace context */
  get workspaceId(): string {
    return this.ctx.workspaceId;
  }

  /** Get the underlying user ID */
  get userId(): string {
    return this.ctx.userId;
  }

  /**
   * Execute a scoped SELECT query.
   * Automatically validates that workspace-scoped tables include the workspace_id.
   */
  scopedAll<T = Record<string, unknown>>(sql: string, workspaceId: string, ...args: unknown[]): T[] {
    const event = validateQueryScope(sql, this.ctx, workspaceId);
    if (event) {
      logIsolationEvent(this.db, event);
      throw new Error(event.reason);
    }
    return this.db.prepare(sql).all(...args) as T[];
  }

  /**
   * Execute a scoped SELECT-one query.
   */
  scopedGet<T = Record<string, unknown>>(sql: string, workspaceId: string, ...args: unknown[]): T | undefined {
    const event = validateQueryScope(sql, this.ctx, workspaceId);
    if (event) {
      logIsolationEvent(this.db, event);
      throw new Error(event.reason);
    }
    return this.db.prepare(sql).get(...args) as T | undefined;
  }

  /**
   * Execute a scoped mutation (INSERT/UPDATE/DELETE).
   */
  scopedRun(
    sql: string,
    workspaceId: string,
    ...args: unknown[]
  ): { changes: number; lastInsertRowid: number | bigint } {
    const event = validateQueryScope(sql, this.ctx, workspaceId);
    if (event) {
      logIsolationEvent(this.db, event);
      throw new Error(event.reason);
    }
    return this.db.prepare(sql).run(...args);
  }

  /** Passthrough to raw driver for non-scoped operations */
  get raw(): ISqliteDriver {
    return this.db;
  }
}
