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
import { signCommand } from '../fleetCommandSigning';
import { verifyAdminPassword } from '../fleetCommandSigning/adminReauth';
import type { DestructiveCommandType, SignedNonDestructiveCommandType } from '../fleetCommandSigning/types';
import {
  DEFAULT_COMMAND_TTL_SECONDS,
  DESTRUCTIVE_COMMAND_TYPES,
  MAX_COMMANDS_PER_HOUR_FLEET_WIDE,
  MAX_PENDING_COMMANDS_PER_DEVICE,
  SIGNED_ENVELOPE_PARAM_KEY,
  SIGNED_NON_DESTRUCTIVE_COMMAND_TYPES,
  isDestructive,
  isSigned,
  type AckStatus,
  type CommandAck,
  type CommandForSlave,
  type CommandRecord,
  type CommandType,
  type CommandWithAcks,
  type EnqueueCommandInput,
} from './types';

// ── Ack listener registry (for IPC emitter wiring) ──────────────────────

type AckNotification = { commandId: string; deviceId: string; status: AckStatus };
let _ackListeners: Array<(n: AckNotification) => void> = [];

/**
 * Subscribe to ack events. Returns an unsubscribe function. fleetBridge
 * uses this to re-emit each ack on the `fleet:command-acked` IPC channel
 * so the admin UI's command-history SWR cache invalidates immediately
 * instead of waiting for the next poll.
 */
export function onCommandAcked(listener: (n: AckNotification) => void): () => void {
  _ackListeners.push(listener);
  return () => {
    _ackListeners = _ackListeners.filter((l) => l !== listener);
  };
}

/** Reset module-level listener state — TEST ONLY. */
export function __resetCommandListenersForTests(): void {
  _ackListeners = [];
}

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
 * Enqueue a NON-destructive command. Guard-rails:
 *   - Rate-limited per-device (10 pending) + fleet-wide (100/hour)
 *   - Rejects destructive types with an exception — those must go
 *     through `enqueueDestructiveCommand` instead
 *
 * Returns the persisted record. Caller is expected to pass a validated
 * CommandType; TypeScript's union narrowing handles the non-destructive
 * vs destructive branch at the type level too.
 */
export function enqueueCommand(db: ISqliteDriver, input: EnqueueCommandInput): CommandRecord {
  if (isDestructive(input.commandType)) {
    throw new Error(
      `Command type ${input.commandType} is destructive and must be enqueued via enqueueDestructiveCommand`
    );
  }
  // Phase B v1.10.0: signed-non-destructive types (agent.execute) also
  // must go through the signed path so payloads get integrity-pinned.
  // Divert to enqueueSignedCommand via a loud error rather than silently
  // downgrading — the renderer's type layer should have caught this
  // already, so a runtime trip here means something bypassed it.
  if (SIGNED_NON_DESTRUCTIVE_COMMAND_TYPES.has(input.commandType)) {
    throw new Error(
      `Command type ${input.commandType} requires a signed envelope; use enqueueSignedCommand instead of enqueueCommand`
    );
  }

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

// ── Phase F.2: destructive enqueue with signing + re-auth ───────────────

/**
 * Result of attempting to enqueue a destructive command. Discriminated
 * union so the IPC boundary can map each failure to a specific toast
 * (wrong password vs rate-limited vs whatever).
 */
export type DestructiveEnqueueResult =
  | { ok: true; commandId: string }
  | {
      ok: false;
      error: string;
      code:
        | 'rate_limited' // admin re-auth throttle kicked in
        | 'unknown_user'
        | 'wrong_password'
        | 'per_device' // command-level rate limit
        | 'fleet_wide'
        | 'error';
    };

/**
 * Destructive enqueue path. Gated on two independent controls:
 *
 *   1. Admin re-auth (fleetCommandSigning/adminReauth) — proves the
 *      human at the keyboard is the admin, not just someone sitting
 *      at an unlocked session
 *   2. Ed25519 signature (fleetCommandSigning.signCommand) — proves
 *      the envelope was minted by THIS master, not spoofed by a MITM
 *
 * Both must pass. Either failing aborts without touching
 * fleet_commands (zero state leakage from the gate).
 *
 * The signed envelope is stored inside `params._signedEnvelope`
 * rather than a new column — the bundle-apply + heartbeat-piggyback
 * wire shapes already ship `params` intact, so this threads through
 * existing transport without a schema change.
 */
export async function enqueueDestructiveCommand(
  db: ISqliteDriver,
  input: {
    targetDeviceId: string;
    commandType: DestructiveCommandType;
    params?: Record<string, unknown>;
    ttlSeconds?: number;
    createdBy: string;
    /** Admin's cleartext password for re-auth. Never persisted. */
    confirmPassword: string;
  }
): Promise<DestructiveEnqueueResult> {
  // 1. Admin re-auth gate — runs BEFORE any DB mutation, so a wrong
  //    password leaves zero residue in fleet_commands or activity_log.
  const reauth = await verifyAdminPassword(db, input.createdBy, input.confirmPassword);
  if (reauth.ok !== true) {
    // Pull `reason` from the failure arm via an explicit non-success cast —
    // TS's narrowing on `!reauth.ok` across await boundaries is flaky.
    const failure = reauth as { ok: false; reason: 'rate_limited' | 'unknown_user' | 'wrong_password' | 'error' };
    return { ok: false, error: `admin re-auth failed: ${failure.reason}`, code: failure.reason };
  }

  // 2. Command-level rate limits (same as non-destructive path).
  try {
    enforceRateLimits(db, input.targetDeviceId);
  } catch (e) {
    if (e instanceof FleetCommandRateLimitError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'error' };
  }

  // 3. Sign + persist. UUID generated first so we can embed it in the
  //    signed body — same id travels through signature + DB row + ack.
  const id = crypto.randomUUID();
  const userParams = input.params ?? {};
  const signed = signCommand(db, {
    commandId: id,
    commandType: input.commandType,
    params: userParams,
    targetDeviceId: input.targetDeviceId,
  });

  // Store envelope alongside user params — slave's executor extracts
  // `_signedEnvelope`, verifies it, then hands the handler the rest.
  const paramsWithEnvelope: Record<string, unknown> = {
    ...userParams,
    [SIGNED_ENVELOPE_PARAM_KEY]: signed,
  };

  const now = Date.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_COMMAND_TTL_SECONDS;
  const expiresAt = now + ttlSeconds * 1000;

  db.prepare(
    `INSERT INTO fleet_commands
     (id, target_device_id, command_type, params, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.targetDeviceId,
    input.commandType,
    JSON.stringify(paramsWithEnvelope),
    now,
    input.createdBy,
    expiresAt
  );

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: input.createdBy,
      action: 'fleet.command.destructive_enqueued',
      entityType: 'fleet_command',
      entityId: id,
      details: {
        commandType: input.commandType,
        targetDeviceId: input.targetDeviceId,
        ttlSeconds,
        nonce: signed.nonce,
      },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-destructive-enqueue', e);
  }

  return { ok: true, commandId: id };
}

// ── Phase B v1.10.0: signed-non-destructive enqueue (no admin re-auth) ──

/**
 * Result of attempting to enqueue a signed non-destructive command.
 * Narrower failure union than destructive enqueue because there's no
 * admin-re-auth gate to fail.
 */
export type SignedEnqueueResult =
  | { ok: true; commandId: string }
  | { ok: false; error: string; code: 'per_device' | 'fleet_wide' | 'error' };

/**
 * Enqueue a signed, non-destructive command. The only caller today is
 * the Phase B FleetAgentAdapter dispatching `agent.execute` to farm
 * slaves. Signature integrity pins the payload (prompts + messages)
 * so a compromised transport can't inject alternate content; no admin
 * re-auth because agent.execute is high-frequency by design.
 *
 * Same ttlSeconds + rate-limit rails as the other two enqueue paths.
 * The envelope travels in `params._signedEnvelope` just like
 * destructive commands; slave verifies via the same `verifyCommand`
 * and accepts via a separate handler map (no confused-deputy risk —
 * verify rejects if the signed type doesn't match what's about to
 * execute).
 */
export function enqueueSignedCommand(
  db: ISqliteDriver,
  input: {
    targetDeviceId: string;
    commandType: SignedNonDestructiveCommandType;
    params?: Record<string, unknown>;
    ttlSeconds?: number;
    createdBy: string;
  }
): SignedEnqueueResult {
  // Type guard: only SignedNonDestructiveCommandType is acceptable here.
  // Destructive types route through enqueueDestructiveCommand (has the
  // admin re-auth gate); bare non-destructive types route through
  // enqueueCommand (no signing at all). This function's tier is the
  // middle: signed but no re-auth.
  if (!SIGNED_NON_DESTRUCTIVE_COMMAND_TYPES.has(input.commandType)) {
    return {
      ok: false,
      error: `Command type ${input.commandType} is not signed-non-destructive; use enqueueCommand or enqueueDestructiveCommand`,
      code: 'error',
    };
  }

  try {
    enforceRateLimits(db, input.targetDeviceId);
  } catch (e) {
    if (e instanceof FleetCommandRateLimitError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e), code: 'error' };
  }

  const id = crypto.randomUUID();
  const userParams = input.params ?? {};
  const signed = signCommand(db, {
    commandId: id,
    commandType: input.commandType,
    params: userParams,
    targetDeviceId: input.targetDeviceId,
  });

  const paramsWithEnvelope: Record<string, unknown> = {
    ...userParams,
    [SIGNED_ENVELOPE_PARAM_KEY]: signed,
  };

  const now = Date.now();
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_COMMAND_TTL_SECONDS;
  const expiresAt = now + ttlSeconds * 1000;

  db.prepare(
    `INSERT INTO fleet_commands
     (id, target_device_id, command_type, params, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.targetDeviceId,
    input.commandType,
    JSON.stringify(paramsWithEnvelope),
    now,
    input.createdBy,
    expiresAt
  );

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: input.createdBy,
      action: 'fleet.command.signed_enqueued',
      entityType: 'fleet_command',
      entityId: id,
      details: {
        commandType: input.commandType,
        targetDeviceId: input.targetDeviceId,
        ttlSeconds,
        nonce: signed.nonce,
      },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-signed-enqueue', e);
  }

  return { ok: true, commandId: id };
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
  const hourlyRow = db.prepare('SELECT COUNT(*) as c FROM fleet_commands WHERE created_at > ?').get(oneHourAgo) as
    | { c: number }
    | undefined;
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
export function getPendingCommandsForDevice(
  db: ISqliteDriver,
  deviceId: string,
  limit: number = 20
): CommandForSlave[] {
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
  const row = db.prepare('SELECT target_device_id FROM fleet_commands WHERE id = ?').get(params.commandId) as
    | { target_device_id: string }
    | undefined;
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

  // Fire-and-forget listener notification so fleetBridge can re-emit
  // the ack over IPC. Swallowing errors per-listener keeps one buggy
  // subscriber from starving the rest.
  for (const listener of _ackListeners) {
    try {
      listener({ commandId: params.commandId, deviceId: params.deviceId, status: params.status });
    } catch (e) {
      logNonCritical('fleet.command.ack-listener', e);
    }
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
    .prepare(`SELECT command_id, status, acked_at FROM fleet_command_acks WHERE command_id IN (${placeholders})`)
    .all(...ids) as Array<{ command_id: string; status: string; acked_at: number }>;

  const ackBucket = new Map<
    string,
    { succeeded: number; failed: number; skipped: number; total: number; lastAckedAt?: number }
  >();
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
