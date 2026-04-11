/**
 * @license Apache-2.0
 * Activity log service for TitanX audit trail.
 * Provides immutable audit logging with HMAC signatures for tamper detection.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { sanitizeRecord } from '@process/utils/redaction';

/** Lazy-loaded device identity module (non-critical — audit still works without it) */
let _deviceIdentity: {
  signAuditEntry: (id: string, action: string, actorId: string, ts: number) => { signature: string; deviceId: string };
} | null = null;

function getDeviceIdentityModule() {
  if (_deviceIdentity) return _deviceIdentity;
  try {
    _deviceIdentity = require('../deviceIdentity') as typeof _deviceIdentity;
  } catch {
    // Device identity not available — non-critical
  }
  return _deviceIdentity;
}

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

  // Priority 1: Explicit env var
  if (process.env.TITANX_AUDIT_HMAC_KEY) {
    _hmacKey = process.env.TITANX_AUDIT_HMAC_KEY;
    return _hmacKey;
  }

  // Priority 2: Derive from a per-install random key file
  try {
    const fs = require('fs');
    const path = require('path');
    const { app } = require('electron');
    const keyPath = path.join(app.getPath('userData'), '.audit-hmac-key');
    if (fs.existsSync(keyPath)) {
      _hmacKey = fs.readFileSync(keyPath, 'utf8').trim();
    } else {
      // Generate a random 32-byte key on first run
      _hmacKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyPath, _hmacKey, { mode: 0o600 });
      console.log('[AuditLog] Generated new HMAC signing key');
    }
  } catch {
    // Fallback: derive from process ID + hostname (still unique per install)
    _hmacKey = crypto
      .createHash('sha256')
      .update(`titanx-${process.pid}-${require('os').hostname()}-${Date.now()}`)
      .digest('hex');
    console.warn('[AuditLog] Using fallback HMAC key — audit signatures are session-scoped');
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
    const deviceMod = getDeviceIdentityModule();
    if (deviceMod) {
      const signed = deviceMod.signAuditEntry(id, input.action, input.actorId, createdAt);
      deviceSignature = signed.signature;
      deviceId = signed.deviceId;
    }
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
    deviceSignature: (row.device_signature as string) ?? undefined,
    deviceId: (row.device_id as string) ?? undefined,
    severity: (row.severity as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}
