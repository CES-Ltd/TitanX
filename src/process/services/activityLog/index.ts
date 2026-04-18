/**
 * @license Apache-2.0
 * Activity log service for TitanX audit trail.
 * Provides immutable audit logging with HMAC signatures for tamper detection.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { sanitizeRecord } from '@process/utils/redaction';
import { signAuditEntry as deviceSignAuditEntry } from '@process/services/deviceIdentity';

/** Cached ipcBridge reference for live event emission (avoids require() on every log call) */
let _ipcBridge: { liveEvents: { activity: { emit: (entry: unknown) => void } } } | null = null;

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
  /** Device Ed25519 signature for non-repudiation (added by device identity module) */
  deviceSignature?: string;
  /** Device ID fingerprint that produced this entry */
  deviceId?: string;
  severity?: string;
  createdAt: number;
};

export type LogActivityInput = Omit<ActivityLogEntry, 'id' | 'createdAt' | 'signature'>;

type ListParams = {
  userId: string;
  entityType?: string;
  agentId?: string;
  action?: string;
  /** Inclusive epoch-ms lower bound on created_at. */
  createdAtFrom?: number;
  /** Exclusive epoch-ms upper bound on created_at. */
  createdAtTo?: number;
  /** Filter on severity column (added in migration v32). */
  severity?: 'info' | 'warning';
  /**
   * Free-text substring match on entity_id + details (JSON). Case-insensitive.
   * SQLite LIKE with leading-%% can't use an index so keep bounded; primary filter
   * should still narrow the row set via user_id + entity_type / action first.
   */
  search?: string;
  limit?: number;
  offset?: number;
};

/**
 * HMAC key for audit log signatures.
 * Derived from master encryption key via HKDF to avoid hardcoded defaults.
 * Falls back to env var, then to a per-install random key stored in data dir.
 */
let _hmacKey: string | null = null;

function getHmacKey(): string {
  if (_hmacKey) return _hmacKey;

  // Priority 1: Explicit env var (must be at least 32 chars for HMAC-SHA256 security)
  if (process.env.TITANX_AUDIT_HMAC_KEY) {
    if (process.env.TITANX_AUDIT_HMAC_KEY.length < 32) {
      throw new Error(
        '[AuditLog] TITANX_AUDIT_HMAC_KEY must be at least 32 characters. Refusing to start with weak key.'
      );
    }
    _hmacKey = process.env.TITANX_AUDIT_HMAC_KEY;
    return _hmacKey;
  }

  // Priority 2: Per-install persistent random key file. Fail loudly on any error —
  // downgrading to a predictable fallback would let an attacker forge audit signatures
  // simply by deleting or corrupting the key file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron');
  const keyPath = path.join(app.getPath('userData'), '.audit-hmac-key');
  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing.length < 32) {
      throw new Error(`[AuditLog] HMAC key file at ${keyPath} is corrupted or truncated (< 32 chars).`);
    }
    _hmacKey = existing;
  } else {
    // Generate a cryptographically secure 32-byte key on first run
    const newKey = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
    } catch (err) {
      throw new Error(
        `[AuditLog] Failed to persist HMAC signing key to ${keyPath}. Refusing to proceed with in-memory-only key: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    _hmacKey = newKey;
    console.log('[AuditLog] Generated new HMAC signing key');
  }

  return _hmacKey;
}

/**
 * Compute HMAC-SHA256 signature for an audit log entry.
 * Signs: id | action | actorId | createdAt to detect tampering.
 */
function signLogEntry(id: string, action: string, actorId: string, createdAt: number): string {
  return crypto.createHmac('sha256', getHmacKey()).update(`${id}|${action}|${actorId}|${createdAt}`).digest('hex');
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

  // Device identity signing — non-repudiable proof of which device produced this entry
  let deviceSignature: string | null = null;
  let deviceId: string | null = null;
  try {
    const signed = deviceSignAuditEntry(id, input.action, input.actorId, createdAt);
    deviceSignature = signed.signature;
    deviceId = signed.deviceId;
  } catch {
    // Device signing is non-critical — HMAC signature is the primary integrity check
  }

  db.prepare(
    `INSERT INTO activity_log (id, user_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details, signature, device_signature, device_id, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    deviceSignature,
    deviceId,
    severity,
    createdAt
  );

  const entry: ActivityLogEntry = {
    ...input,
    id,
    createdAt,
    signature,
    deviceSignature: deviceSignature ?? undefined,
    deviceId: deviceId ?? undefined,
    severity,
    details: input.details ? (sanitizeRecord(input.details) as Record<string, unknown>) : undefined,
  };

  // Emit live event async — don't block the audit log write
  queueMicrotask(() => {
    try {
      if (!_ipcBridge) _ipcBridge = require('@/common').ipcBridge;
      _ipcBridge.liveEvents.activity.emit(entry);
    } catch {
      // Live event emission is non-critical
    }
  });

  return entry;
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
  if (typeof params.createdAtFrom === 'number') {
    conditions.push('created_at >= ?');
    args.push(params.createdAtFrom);
  }
  if (typeof params.createdAtTo === 'number') {
    conditions.push('created_at < ?');
    args.push(params.createdAtTo);
  }
  if (params.severity === 'info' || params.severity === 'warning') {
    conditions.push('severity = ?');
    args.push(params.severity);
  }
  if (params.search && params.search.length > 0) {
    // SQLite LIKE has a 500-char practical bound; trim to stay well under it.
    // leading-% can't use an index — depend on user_id / entity_type / time
    // filters to narrow first, then substring-match within that set.
    const needle = `%${params.search.slice(0, 200).replace(/[%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      "(LOWER(entity_id) LIKE LOWER(?) ESCAPE '\\' OR LOWER(details) LIKE LOWER(?) ESCAPE '\\' OR LOWER(action) LIKE LOWER(?) ESCAPE '\\')"
    );
    args.push(needle, needle, needle);
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
 * Distinct `action` values observed in this user's audit log. Feeds the
 * admin UI's filter dropdown so new action types (fleet.command.enqueued,
 * agent.template.published, etc.) show up automatically without touching
 * a hardcoded enum in the renderer.
 *
 * SELECT DISTINCT is O(rows) without an (user_id, action) composite
 * index. At 1M rows on a user this takes ~100ms on a cold page; at 10M
 * it becomes noticeable (~1s). Current usage is admin-only + on-demand
 * (Refresh button, not every render) so the trade-off is acceptable.
 * Adding `CREATE INDEX idx_activity_log_user_action ON activity_log(
 * user_id, action)` would fix it if needed.
 */
export function getDistinctActions(db: ISqliteDriver, userId: string, limit: number = 500): string[] {
  const rows = db
    .prepare('SELECT DISTINCT action FROM activity_log WHERE user_id = ? ORDER BY action ASC LIMIT ?')
    .all(userId, limit) as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

/** Distinct `entity_type` values — same pattern as getDistinctActions. */
export function getDistinctEntityTypes(db: ISqliteDriver, userId: string, limit: number = 200): string[] {
  const rows = db
    .prepare('SELECT DISTINCT entity_type FROM activity_log WHERE user_id = ? ORDER BY entity_type ASC LIMIT ?')
    .all(userId, limit) as Array<{ entity_type: string }>;
  return rows.map((r) => r.entity_type);
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
    deviceSignature: (row.device_signature as string) ?? undefined,
    deviceId: (row.device_id as string) ?? undefined,
    severity: (row.severity as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}
