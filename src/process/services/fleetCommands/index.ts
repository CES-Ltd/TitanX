/**
 * @license Apache-2.0
 * Fleet remote commands service (Phase F Week 1).
 *
 * Two roles:
 *   - Master: `enqueueCommand()` writes a row to fleet_commands. The
 *     heartbeat endpoint (Phase B) calls `getPendingCommandsForDevice()`
 *     on every slave ping and piggybacks the result in the response.
 *   - Slave-as-seen-from-master: `ackCommand()` records what each
 *     device did with the command. `listCommandsWithAcks()` feeds the
 *     admin "command history" table.
 *
 * No signed envelopes in Phase F v1. Justification:
 *   - Transport is HTTPS + device-JWT bearer (Phase B proved this
 *     reaches slaves reliably)
 *   - Commands are non-destructive — worst case of a replay is an
 *     extra pollOnce() / pushNow() call, which the in-flight guard
 *     already coalesces
 *   - `expires_at` bounds command lifetime, so stale replays stop
 *     firing after ttlSeconds
 *
 * Before destructive command types (agent.restart, cache.clear) can
 * ship, we need: admin re-auth on enqueue, signed command envelopes
 * with a nonce, and an audit trail on every ack. That's Phase F.2.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import {
  DEFAULT_COMMAND_TTL_SECONDS,
  MAX_COMMANDS_PER_HOUR_FLEET_WIDE,
  MAX_PENDING_COMMANDS_PER_DEVICE,
  type AckStatus,
  type CommandAck,
  type CommandForSlave,
  type CommandRecord,
  type CommandWithAcks,
  type EnqueueCommandInput,
} from './types';

// ── Master: enqueue ─────────────────────────────────────────────────────

/**
 * Error thrown when enqueueing a command would exceed a rate limit.
 * Renderer matches on `name === 'FleetCommandRateLimitError'` to show
 * a toast instead of treating it as a generic failure.
 */
export class FleetCommandRateLimitError extends Error {
  readonly code: 'per_device' | 'fleet_wide';
  constructor(code: 'per_device' | 'fleet_wide', message: string) {
    super(message);
    this.name = 'FleetCommandRateLimitError';
    this.code = code;
  }
}

/**
 * Enqueue a command. Returns the persisted record. Rate-limited on two
 * axes — per-target-device (at most 10 pending) and fleet-wide
 * (at most 100 per rolling hour) — to keep a runaway admin script or
 * UI bug from flooding slaves.
 */
export function enqueueCommand(db: ISqliteDriver, input: EnqueueCommandInput): CommandRecord {
  enforceRateLimits(db, input.targetDeviceId);

  const id = crypto.randomUUID();
  const now = Date.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_COMMAND_TTL_SECONDS;
  const expiresAt = now + ttlSeconds * 1000;
  const params = input.params ?? {};

  db.prepare(
    `INSERT INTO fleet_commands
     (id, target_device_id, command_type, params, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.targetDeviceId, input.commandType, JSON.stringify(params), now, input.createdBy, expiresAt);

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: input.createdBy,
      action: 'fleet.command.enqueued',
      entityType: 'fleet_command',
      entityId: id,
      details: {
        commandType: input.commandType,
        targetDeviceId: input.targetDeviceId,
        ttlSeconds,
      },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-enqueue', e);
  }

  return {
    id,
    targetDeviceId: input.targetDeviceId,
    commandType: input.commandType,
    params,
    createdAt: now,
    createdBy: input.createdBy,
    expiresAt,
  };
}

function enforceRateLimits(db: ISqliteDriver, targetDeviceId: string): void {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  // Per-device pending count (excluding 'all' — fleet-wide commands
  // count toward the fleet-wide limit, not the per-device one).
  if (targetDeviceId !== 'all') {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM fleet_commands
         WHERE target_device_id = ? AND revoked_at IS NULL AND expires_at > ?`
      )
      .get(targetDeviceId, now) as { c: number } | undefined;
    if ((row?.c ?? 0) >= MAX_PENDING_COMMANDS_PER_DEVICE) {
      throw new FleetCommandRateLimitError(
        'per_device',
        `Too many pending commands for device ${targetDeviceId} (max ${String(MAX_PENDING_COMMANDS_PER_DEVICE)}).`
      );
    }
  }

  // Fleet-wide rolling hour (all commands, including 'all' targets).
  const hourlyRow = db
    .prepare('SELECT COUNT(*) as c FROM fleet_commands WHERE created_at > ?')
    .get(oneHourAgo) as { c: number } | undefined;
  if ((hourlyRow?.c ?? 0) >= MAX_COMMANDS_PER_HOUR_FLEET_WIDE) {
    throw new FleetCommandRateLimitError(
      'fleet_wide',
      `Fleet-wide command rate limit reached (max ${String(MAX_COMMANDS_PER_HOUR_FLEET_WIDE)}/hour).`
    );
  }
}

// ── Master: pending commands for one device (heartbeat piggyback) ───────

/**
 * Return the set of commands a given device should execute. Picks up
 * both 'all'-targeted and device-specific commands, filters out expired
 * / revoked / already-acked rows. ORDER BY created_at ASC gives FIFO
 * semantics — the oldest command the device hasn't seen yet runs first.
 *
 * Hot path: runs on every heartbeat (60 s × active slaves). The
 * composite index on (target_device_id, expires_at DESC) makes the
 * scan bounded even with thousands of historical commands.
 */
export function getPendingCommandsForDevice(db: ISqliteDriver, deviceId: string, limit: number = 20): CommandForSlave[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT c.id, c.command_type, c.params, c.created_at
       FROM fleet_commands c
       LEFT JOIN fleet_command_acks a ON a.command_id = c.id AND a.device_id = ?
       WHERE (c.target_device_id = ? OR c.target_device_id = 'all')
         AND c.revoked_at IS NULL
         AND c.expires_at > ?
         AND a.command_id IS NULL
       ORDER BY c.created_at ASC
       LIMIT ?`
    )
    .all(deviceId, deviceId, now, limit) as Array<{
    id: string;
    command_type: string;
    params: string;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    commandType: r.command_type as CommandForSlave['commandType'],
    params: safeParse(r.params),
    createdAt: r.created_at,
  }));
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v != null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Master: ingest ack from slave ───────────────────────────────────────

/**
 * Record the slave's outcome of a command. Upsert on
 * (command_id, device_id) so a retrying slave updates its row rather
 * than creating duplicates. Validates that the command actually
 * exists + is addressed to this device (defensive — a misbehaving
 * slave can't pollute another device's ack row).
 *
 * Returns false when the command id is unknown or was not targeted at
 * this device (with 'all' target, any enrolled device may ack).
 */
export function ackCommand(
  db: ISqliteDriver,
  params: { commandId: string; deviceId: string; status: AckStatus; result?: Record<string, unknown> }
): boolean {
  const row = db
    .prepare('SELECT target_device_id FROM fleet_commands WHERE id = ?')
    .get(params.commandId) as { target_device_id: string } | undefined;
  if (!row) return false;
  if (row.target_device_id !== 'all' && row.target_device_id !== params.deviceId) {
    return false;
  }

  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO fleet_command_acks
     (command_id, device_id, status, result, acked_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(params.commandId, params.deviceId, params.status, JSON.stringify(params.result ?? {}), now);

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_command_ack',
      action: 'fleet.command.acked',
      entityType: 'fleet_command',
      entityId: params.commandId,
      details: { deviceId: params.deviceId, status: params.status },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-ack', e);
  }

  return true;
}

// ── Master: admin queries ───────────────────────────────────────────────

/**
 * Cancel a pending command. Slaves that haven't picked it up yet never
 * see it on their next heartbeat; slaves that already executed it keep
 * their ack row so the audit trail stays intact.
 */
export function revokeCommand(db: ISqliteDriver, commandId: string, revokedBy: string): boolean {
  const result = db
    .prepare('UPDATE fleet_commands SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), commandId);
  if (result.changes === 0) return false;

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: revokedBy,
      action: 'fleet.command.revoked',
      entityType: 'fleet_command',
      entityId: commandId,
      details: {},
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-revoke', e);
  }
  return true;
}

/** List recent commands with their ack rollups. For the admin UI. */
export function listCommandsWithAcks(db: ISqliteDriver, limit: number = 50): CommandWithAcks[] {
  const cmdRows = db
    .prepare(
      `SELECT id, target_device_id, command_type, params, created_at, created_by, expires_at, revoked_at
       FROM fleet_commands
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    target_device_id: string;
    command_type: string;
    params: string;
    created_at: number;
    created_by: string;
    expires_at: number;
    revoked_at: number | null;
  }>;

  if (cmdRows.length === 0) return [];

  const ids = cmdRows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const ackRows = db
    .prepare(
      `SELECT command_id, status, acked_at FROM fleet_command_acks WHERE command_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ command_id: string; status: string; acked_at: number }>;

  const ackBucket = new Map<string, { succeeded: number; failed: number; skipped: number; total: number; lastAckedAt?: number }>();
  for (const id of ids) ackBucket.set(id, { succeeded: 0, failed: 0, skipped: 0, total: 0 });
  for (const a of ackRows) {
    const b = ackBucket.get(a.command_id);
    if (!b) continue;
    b.total += 1;
    if (a.status === 'succeeded') b.succeeded += 1;
    else if (a.status === 'failed') b.failed += 1;
    else if (a.status === 'skipped') b.skipped += 1;
    b.lastAckedAt = b.lastAckedAt == null ? a.acked_at : Math.max(b.lastAckedAt, a.acked_at);
  }

  return cmdRows.map((r) => ({
    id: r.id,
    targetDeviceId: r.target_device_id,
    commandType: r.command_type as CommandWithAcks['commandType'],
    params: safeParse(r.params),
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at ?? undefined,
    acks: ackBucket.get(r.id)!,
  }));
}

/** Fetch a single command's ack rows. For drill-down in the UI. */
export function listAcksForCommand(db: ISqliteDriver, commandId: string): CommandAck[] {
  const rows = db
    .prepare(
      `SELECT command_id, device_id, status, result, acked_at
       FROM fleet_command_acks
       WHERE command_id = ?
       ORDER BY acked_at DESC`
    )
    .all(commandId) as Array<{
    command_id: string;
    device_id: string;
    status: string;
    result: string;
    acked_at: number;
  }>;

  return rows.map((r) => ({
    commandId: r.command_id,
    deviceId: r.device_id,
    status: r.status as AckStatus,
    result: safeParse(r.result),
    ackedAt: r.acked_at,
  }));
}
