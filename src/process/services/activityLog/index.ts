/**
 * @license Apache-2.0
 * Activity log service for TitanX audit trail.
 * Provides immutable audit logging for all state-changing operations.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { sanitizeRecord } from '@process/utils/redaction';

type ActivityLogEntry = {
  id: string;
  userId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
  createdAt: number;
};

type LogActivityInput = Omit<ActivityLogEntry, 'id' | 'createdAt'>;

type ListParams = {
  userId: string;
  entityType?: string;
  agentId?: string;
  action?: string;
  limit?: number;
  offset?: number;
};

/**
 * Record an activity in the immutable audit log.
 * Details are automatically sanitized to remove sensitive fields.
 */
export function logActivity(db: ISqliteDriver, input: LogActivityInput): ActivityLogEntry {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const sanitizedDetails = input.details ? JSON.stringify(sanitizeRecord(input.details)) : '{}';

  db.prepare(
    `INSERT INTO activity_log (id, user_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.actorType,
    input.actorId,
    input.action,
    input.entityType,
    input.entityId ?? null,
    input.agentId ?? null,
    sanitizedDetails,
    createdAt
  );

  return {
    ...input,
    id,
    createdAt,
    details: input.details ? (sanitizeRecord(input.details) as Record<string, unknown>) : undefined,
  };
}

/**
 * List activity log entries with optional filters.
 */
export function listActivities(db: ISqliteDriver, params: ListParams): { data: ActivityLogEntry[]; total: number } {
  const conditions: string[] = ['user_id = ?'];
  const args: unknown[] = [params.userId];

  if (params.entityType) {
    conditions.push('entity_type = ?');
    args.push(params.entityType);
  }
  if (params.agentId) {
    conditions.push('agent_id = ?');
    args.push(params.agentId);
  }
  if (params.action) {
    conditions.push('action = ?');
    args.push(params.action);
  }

  const where = conditions.join(' AND ');
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM activity_log WHERE ${where}`).get(...args) as { count: number }
  ).count;

  const rows = db
    .prepare(`SELECT * FROM activity_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as Array<Record<string, unknown>>;

  const data = rows.map(rowToActivityEntry);
  return { data, total };
}

/**
 * Get activities for a specific entity.
 */
export function getActivitiesForEntity(db: ISqliteDriver, entityType: string, entityId: string): ActivityLogEntry[] {
  const rows = db
    .prepare(`SELECT * FROM activity_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(entityType, entityId) as Array<Record<string, unknown>>;

  return rows.map(rowToActivityEntry);
}

function rowToActivityEntry(row: Record<string, unknown>): ActivityLogEntry {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    actorType: row.actor_type as 'user' | 'agent' | 'system',
    actorId: row.actor_id as string,
    action: row.action as string,
    entityType: row.entity_type as string,
    entityId: (row.entity_id as string) ?? undefined,
    agentId: (row.agent_id as string) ?? undefined,
    details: row.details ? JSON.parse(row.details as string) : undefined,
    createdAt: row.created_at as number,
  };
}
