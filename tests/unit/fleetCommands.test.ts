/**
 * @license Apache-2.0
 * Unit tests for the fleet commands service (Phase F Week 1).
 *
 * In-memory SQLite (same pattern as fleetConfig / fleetTelemetry tests,
 * skipped when the native module can't load in the harness).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  ackCommand,
  enqueueCommand,
  FleetCommandRateLimitError,
  getPendingCommandsForDevice,
  listAcksForCommand,
  listCommandsWithAcks,
  revokeCommand,
} from '@process/services/fleetCommands';
import {
  MAX_COMMANDS_PER_HOUR_FLEET_WIDE,
  MAX_PENDING_COMMANDS_PER_DEVICE,
} from '@process/services/fleetCommands/types';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 67);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

// ── enqueueCommand ──────────────────────────────────────────────────────

describeOrSkip('fleetCommands — enqueueCommand', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('persists a command row and returns its record', () => {
    const cmd = enqueueCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'force_config_sync',
      createdBy: 'admin',
    });
    expect(cmd.id).toBeTruthy();
    expect(cmd.expiresAt).toBeGreaterThan(cmd.createdAt);

    const row = db.prepare('SELECT * FROM fleet_commands WHERE id = ?').get(cmd.id) as
      | { target_device_id: string; command_type: string; params: string; revoked_at: number | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.target_device_id).toBe('dev-a');
    expect(row!.command_type).toBe('force_config_sync');
    expect(row!.revoked_at).toBeNull();
  });

  it('honors custom ttlSeconds', () => {
    const cmd = enqueueCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'force_telemetry_push',
      ttlSeconds: 120,
      createdBy: 'admin',
    });
    expect(cmd.expiresAt - cmd.createdAt).toBe(120 * 1000);
  });

  it('writes an audit row on every enqueue', () => {
    enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    const audits = db
      .prepare("SELECT * FROM activity_log WHERE action = 'fleet.command.enqueued'")
      .all() as Array<{ entity_id: string }>;
    expect(audits).toHaveLength(1);
  });
});

// ── rate limits ────────────────────────────────────────────────────────

describeOrSkip('fleetCommands — rate limits', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('throws per_device after 10 pending commands to same device', () => {
    for (let i = 0; i < MAX_PENDING_COMMANDS_PER_DEVICE; i++) {
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    }
    let caught: unknown;
    try {
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FleetCommandRateLimitError);
    expect((caught as FleetCommandRateLimitError).code).toBe('per_device');
  });

  it('per_device limit does NOT apply to target=all (those count toward fleet-wide only)', () => {
    // 10 pending to dev-a — maxed on per-device
    for (let i = 0; i < MAX_PENDING_COMMANDS_PER_DEVICE; i++) {
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    }
    // An 'all' command should still go through
    expect(() =>
      enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' })
    ).not.toThrow();
  });

  it('does NOT count revoked / expired commands toward per_device limit', () => {
    // Fill the quota
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_COMMANDS_PER_DEVICE; i++) {
      ids.push(
        enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' }).id
      );
    }
    // Revoke one — a new enqueue should succeed
    revokeCommand(db, ids[0]!, 'admin');
    expect(() =>
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' })
    ).not.toThrow();
  });

  it('throws fleet_wide after MAX commands in an hour', () => {
    // Write 100 non-rate-limited commands by bypassing the service's
    // enqueueCommand check — we only want to exercise the fleet_wide
    // branch here, not the per-device one.
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO fleet_commands (id, target_device_id, command_type, params, created_at, created_by, expires_at)
       VALUES (?, ?, ?, '{}', ?, ?, ?)`
    );
    for (let i = 0; i < MAX_COMMANDS_PER_HOUR_FLEET_WIDE; i++) {
      stmt.run(`c-${String(i)}`, 'all', 'force_config_sync', now - i, 'admin', now + 3600_000);
    }

    let caught: unknown;
    try {
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FleetCommandRateLimitError);
    expect((caught as FleetCommandRateLimitError).code).toBe('fleet_wide');
  });
});

// ── getPendingCommandsForDevice ────────────────────────────────────────

describeOrSkip('fleetCommands — getPendingCommandsForDevice', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns empty list for a device with no commands', () => {
    expect(getPendingCommandsForDevice(db, 'dev-a')).toEqual([]);
  });

  it('returns device-specific commands', () => {
    const a = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    enqueueCommand(db, { targetDeviceId: 'dev-b', commandType: 'force_config_sync', createdBy: 'admin' });
    const rows = getPendingCommandsForDevice(db, 'dev-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.id);
  });

  it("returns 'all'-targeted commands to every device", () => {
    const all = enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' });
    expect(getPendingCommandsForDevice(db, 'dev-a').map((r) => r.id)).toEqual([all.id]);
    expect(getPendingCommandsForDevice(db, 'dev-b').map((r) => r.id)).toEqual([all.id]);
  });

  it('excludes expired commands', () => {
    enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin', ttlSeconds: -10 });
    expect(getPendingCommandsForDevice(db, 'dev-a')).toEqual([]);
  });

  it('excludes revoked commands', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    revokeCommand(db, cmd.id, 'admin');
    expect(getPendingCommandsForDevice(db, 'dev-a')).toEqual([]);
  });

  it('excludes commands already acked by this device', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    ackCommand(db, { commandId: cmd.id, deviceId: 'dev-a', status: 'succeeded' });
    expect(getPendingCommandsForDevice(db, 'dev-a')).toEqual([]);
  });

  it("for an 'all' command: device that acked drops, others still see it", () => {
    const all = enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-a', status: 'succeeded' });
    expect(getPendingCommandsForDevice(db, 'dev-a')).toEqual([]);
    expect(getPendingCommandsForDevice(db, 'dev-b').map((r) => r.id)).toEqual([all.id]);
  });

  it('orders by created_at ASC (FIFO dispatch)', async () => {
    const first = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    await new Promise((r) => setTimeout(r, 2));
    const second = enqueueCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'force_telemetry_push',
      createdBy: 'admin',
    });
    const rows = getPendingCommandsForDevice(db, 'dev-a');
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    }
    expect(getPendingCommandsForDevice(db, 'dev-a', 2)).toHaveLength(2);
  });
});

// ── ackCommand ─────────────────────────────────────────────────────────

describeOrSkip('fleetCommands — ackCommand', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('persists a new ack row', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    const ok = ackCommand(db, { commandId: cmd.id, deviceId: 'dev-a', status: 'succeeded' });
    expect(ok).toBe(true);
    const row = db.prepare('SELECT * FROM fleet_command_acks WHERE command_id = ?').get(cmd.id) as
      | { device_id: string; status: string }
      | undefined;
    expect(row?.device_id).toBe('dev-a');
    expect(row?.status).toBe('succeeded');
  });

  it('upsert on (command_id, device_id) — retry updates row, does not duplicate', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    ackCommand(db, { commandId: cmd.id, deviceId: 'dev-a', status: 'succeeded' });
    ackCommand(db, { commandId: cmd.id, deviceId: 'dev-a', status: 'failed', result: { error: 'oops' } });
    const rows = db.prepare('SELECT status FROM fleet_command_acks WHERE command_id = ?').all(cmd.id) as Array<{
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
  });

  it('rejects ack from a device not addressed by the command', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    const ok = ackCommand(db, { commandId: cmd.id, deviceId: 'dev-b', status: 'succeeded' });
    expect(ok).toBe(false);
  });

  it("accepts acks from any device for 'all'-targeted commands", () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' });
    expect(ackCommand(db, { commandId: cmd.id, deviceId: 'dev-a', status: 'succeeded' })).toBe(true);
    expect(ackCommand(db, { commandId: cmd.id, deviceId: 'dev-b', status: 'succeeded' })).toBe(true);
  });

  it('returns false for unknown command id', () => {
    expect(ackCommand(db, { commandId: 'not-a-real-id', deviceId: 'dev-a', status: 'succeeded' })).toBe(false);
  });
});

// ── revokeCommand + listCommandsWithAcks ────────────────────────────────

describeOrSkip('fleetCommands — revoke + list', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('revokeCommand flips revoked_at and returns true', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    expect(revokeCommand(db, cmd.id, 'admin')).toBe(true);
    const row = db.prepare('SELECT revoked_at FROM fleet_commands WHERE id = ?').get(cmd.id) as
      | { revoked_at: number | null }
      | undefined;
    expect(row?.revoked_at).toBeTruthy();
  });

  it('revokeCommand is idempotent — second call returns false', () => {
    const cmd = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    expect(revokeCommand(db, cmd.id, 'admin')).toBe(true);
    expect(revokeCommand(db, cmd.id, 'admin')).toBe(false);
  });

  it('listCommandsWithAcks rolls up ack counts', () => {
    const all = enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-a', status: 'succeeded' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-b', status: 'succeeded' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-c', status: 'failed' });

    const rows = listCommandsWithAcks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acks.succeeded).toBe(2);
    expect(rows[0]!.acks.failed).toBe(1);
    expect(rows[0]!.acks.total).toBe(3);
  });

  it('listAcksForCommand returns one row per device', () => {
    const all = enqueueCommand(db, { targetDeviceId: 'all', commandType: 'force_config_sync', createdBy: 'admin' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-a', status: 'succeeded' });
    ackCommand(db, { commandId: all.id, deviceId: 'dev-b', status: 'failed', result: { error: 'network' } });
    const acks = listAcksForCommand(db, all.id);
    expect(acks).toHaveLength(2);
    const byDevice = Object.fromEntries(acks.map((a) => [a.deviceId, a]));
    expect(byDevice['dev-a']?.status).toBe('succeeded');
    expect(byDevice['dev-b']?.status).toBe('failed');
    expect(byDevice['dev-b']?.result).toEqual({ error: 'network' });
  });

  it('list orders newest-first', async () => {
    const first = enqueueCommand(db, { targetDeviceId: 'dev-a', commandType: 'force_config_sync', createdBy: 'admin' });
    await new Promise((r) => setTimeout(r, 2));
    const second = enqueueCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'force_telemetry_push',
      createdBy: 'admin',
    });
    const rows = listCommandsWithAcks(db);
    expect(rows[0]!.id).toBe(second.id);
    expect(rows[1]!.id).toBe(first.id);
  });
});
