/**
 * @license Apache-2.0
 * Activity log service for TitanX audit trail.
 * Provides immutable audit logging with HMAC signatures for tamper detection.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { sanitizeRecord } from '@process/utils/redaction';

export type ActivityLogEntry = {
  id: string;
  userId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
  signature?: string;
  severity?: string;
  createdAt: number;
};

export type LogActivityInput = Omit<ActivityLogEntry, 'id' | 'createdAt' | 'signature'>;

type ListParams = {
  userId: string;
  entityType?: string;
  agentId?: string;
  action?: string;
  limit?: number;
  offset?: number;
};

/** HMAC key for audit log signatures. In production, derive from master key. */
const HMAC_KEY = process.env.TITANX_AUDIT_HMAC_KEY ?? 'titanx-audit-log-default-key-change-in-production';

/**
 * Compute HMAC-SHA256 signature for an audit log entry.
 * Signs: id | action | actorId | createdAt to detect tampering.
 */
function signLogEntry(id: string, action: string, actorId: string, createdAt: number): string {
  return crypto.createHmac('sha256', HMAC_KEY).update(`${id}|${action}|${actorId}|${createdAt}`).digest('hex');
}

/**
 * Verify HMAC signature of an audit log entry.
 * Returns true if the signature is valid, false if tampered.
 */
export function verifyLogEntry(entry: ActivityLogEntry): boolean {
  if (!entry.signature) return false;
  const expected = signLogEntry(entry.id, entry.action, entry.actorId, entry.createdAt);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(entry.signature, 'hex');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Record an activity in the immutable audit log.
 * Details are automatically sanitized. Entry is HMAC-signed for tamper detection.
 */
export function logActivity(db: ISqliteDriver, input: LogActivityInput): ActivityLogEntry {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const sanitizedDetails = input.details ? JSON.stringify(sanitizeRecord(input.details)) : '{}';
  const severity =
    input.severity ?? (input.action.includes('denied') || input.action.includes('blocked') ? 'warning' : 'info');
  const signature = signLogEntry(id, input.action, input.actorId, createdAt);

  db.prepare(
    `INSERT INTO activity_log (id, user_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, signature, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    signature,
    severity,
    createdAt
  );

  return {
    ...input,
    id,
    createdAt,
    signature,
    severity,
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
    signature: (row.signature as string) ?? undefined,
    severity: (row.severity as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}
