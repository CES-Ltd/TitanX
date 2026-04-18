/**
 * @license Apache-2.0
 * Unit tests for Phase B (v1.10.0) data model + enqueue + job-query
 * plumbing. Exercises real SQLite via BetterSqlite3Driver so the
 * CHECK constraints, foreign-key defaults, and indexes run for real.
 *
 * Skipped in environments where better-sqlite3's native binding can't
 * load (same guard pattern as the existing fleetCommands tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  enqueueCommand,
  enqueueSignedCommand,
  getPendingCommandsForDevice,
  ackCommand,
  __resetCommandListenersForTests,
} from '@process/services/fleetCommands';
import { SIGNED_ENVELOPE_PARAM_KEY } from '@process/services/fleetCommands/types';
import { verifyCommand, getMasterSigningPublicKey } from '@process/services/fleetCommandSigning';
import { __resetReauthForTests } from '@process/services/fleetCommandSigning/adminReauth';
import { listFarmJobs, summarizeFarmJobs } from '@process/services/fleetAgentJobs';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

const ADMIN = 'admin';

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 69);
  const hash = bcrypt.hashSync('strong-password-1234', 4);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ADMIN, ADMIN, hash, Date.now(), Date.now());
  return driver;
}

// ── Migration v69 shape ────────────────────────────────────────────────

describeOrSkip('Migration v69 — Agent Farm tables', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('creates fleet_farm_devices with role CHECK constraint', () => {
    const info = db.prepare('PRAGMA table_info(fleet_farm_devices)').all() as Array<{ name: string }>;
    const colNames = info.map((c) => c.name).toSorted();
    expect(colNames).toEqual(['capabilities', 'compute_budget_cents', 'device_id', 'role', 'updated_at']);

    // CHECK constraint rejects an unknown role.
    expect(() =>
      db
        .prepare(`INSERT INTO fleet_farm_devices (device_id, role, capabilities, updated_at) VALUES (?, ?, ?, ?)`)
        .run('dev-1', 'coordinator', '{}', Date.now())
    ).toThrow();

    // Valid roles insert cleanly.
    db.prepare(`INSERT INTO fleet_farm_devices (device_id, role, capabilities, updated_at) VALUES (?, ?, ?, ?)`).run(
      'dev-1',
      'farm',
      '{}',
      Date.now()
    );
    const row = db.prepare('SELECT role FROM fleet_farm_devices WHERE device_id = ?').get('dev-1') as { role: string };
    expect(row.role).toBe('farm');
  });

  it('creates fleet_agent_jobs with status CHECK + indexes', () => {
    const info = db.prepare('PRAGMA table_info(fleet_agent_jobs)').all() as Array<{ name: string }>;
    expect(info.some((c) => c.name === 'id')).toBe(true);
    expect(info.some((c) => c.name === 'status')).toBe(true);

    const indexes = db.prepare('PRAGMA index_list(fleet_agent_jobs)').all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_fleet_jobs_device_status');
    expect(names).toContain('idx_fleet_jobs_team');

    // Status CHECK rejects an unknown literal.
    expect(() =>
      db
        .prepare(
          `INSERT INTO fleet_agent_jobs (id, device_id, team_id, agent_slot_id, request_payload, status, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('j1', 'dev-1', 'team-1', 'slot-1', '{}', 'zombie', Date.now())
    ).toThrow();
  });
});

// ── enqueueSignedCommand + slave-side verify ───────────────────────────

describeOrSkip('enqueueSignedCommand — Phase B signed non-destructive tier', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    __resetReauthForTests();
    __resetCommandListenersForTests();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('signs agent.execute without admin re-auth', () => {
    const result = enqueueSignedCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'agent.execute',
      params: { jobId: 'job-1', agentTemplateId: 'tmpl-1', messages: [] },
      createdBy: 'admin',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pending = getPendingCommandsForDevice(db, 'dev-a');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.commandType).toBe('agent.execute');

    // Envelope travels in params._signedEnvelope (same wire format as
    // destructive commands), so the slave-side verify pipeline works
    // without needing a new transport.
    const envelope = (pending[0]!.params as Record<string, unknown>)[SIGNED_ENVELOPE_PARAM_KEY];
    expect(envelope).toBeDefined();

    const pubKey = getMasterSigningPublicKey(db);
    const verify = verifyCommand(db, pubKey, envelope);
    expect(verify.ok).toBe(true);
  });

  it('rejects destructive types on the signed-non-destructive path', () => {
    const result = enqueueSignedCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'cache.clear' as unknown as 'agent.execute',
      params: {},
      createdBy: 'admin',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('error');
    expect(result.error).toMatch(/not signed-non-destructive/);
  });

  it('enforces the same per-device rate limit as destructive enqueue', () => {
    // MAX_PENDING_COMMANDS_PER_DEVICE = 10 — 10 succeed, 11th fails.
    for (let i = 0; i < 10; i++) {
      const r = enqueueSignedCommand(db, {
        targetDeviceId: 'dev-a',
        commandType: 'agent.execute',
        params: { jobId: `j${String(i)}` },
        createdBy: 'admin',
      });
      expect(r.ok).toBe(true);
    }
    const overflow = enqueueSignedCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'agent.execute',
      params: { jobId: 'j-overflow' },
      createdBy: 'admin',
    });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.code).toBe('per_device');
  });

  it('enqueueCommand rejects signed-non-destructive types with a loud error', () => {
    expect(() =>
      enqueueCommand(db, {
        targetDeviceId: 'dev-a',
        commandType: 'agent.execute' as unknown as 'force_config_sync',
        createdBy: 'admin',
      })
    ).toThrow(/signed envelope.*enqueueSignedCommand/);
  });
});

// ── fleet_agent_jobs read helpers ──────────────────────────────────────

describeOrSkip('fleetAgentJobs — query helpers', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function insertJob(
    id: string,
    deviceId: string,
    status: 'queued' | 'completed' | 'failed' | 'timeout',
    enqueuedAt: number,
    completedAt?: number
  ) {
    db.prepare(
      `INSERT INTO fleet_agent_jobs
       (id, device_id, team_id, agent_slot_id, request_payload, status, enqueued_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, deviceId, 'team-1', 'slot-1', '{}', status, enqueuedAt, completedAt ?? null);
  }

  it('listFarmJobs returns newest first and respects limit', () => {
    insertJob('j1', 'dev-a', 'completed', 1000);
    insertJob('j2', 'dev-a', 'completed', 2000);
    insertJob('j3', 'dev-b', 'failed', 3000);
    const jobs = listFarmJobs(db, 2);
    expect(jobs.map((j) => j.id)).toEqual(['j3', 'j2']);
  });

  it('summarizeFarmJobs buckets by deviceId with correct counts', () => {
    insertJob('j1', 'dev-a', 'completed', 1000, 1500);
    insertJob('j2', 'dev-a', 'completed', 2000, 2400);
    insertJob('j3', 'dev-a', 'failed', 2500);
    insertJob('j4', 'dev-b', 'timeout', 3000);

    const summary = summarizeFarmJobs(db, 0, 4000);
    const devA = summary.find((s) => s.deviceId === 'dev-a');
    const devB = summary.find((s) => s.deviceId === 'dev-b');
    expect(devA).toBeDefined();
    expect(devB).toBeDefined();
    if (!devA || !devB) return;

    expect(devA.jobsTotal).toBe(3);
    expect(devA.jobsCompleted).toBe(2);
    expect(devA.jobsFailed).toBe(1);
    // (500 + 400) / 2 = 450
    expect(devA.avgLatencyMs).toBe(450);

    expect(devB.jobsTotal).toBe(1);
    expect(devB.jobsTimeout).toBe(1);
  });

  it('summarizeFarmJobs respects the time window', () => {
    insertJob('j1', 'dev-a', 'completed', 1000, 1500);
    insertJob('j2', 'dev-a', 'completed', 5000, 5400);
    const early = summarizeFarmJobs(db, 0, 2000);
    const late = summarizeFarmJobs(db, 4000, 6000);
    expect(early[0]?.jobsTotal).toBe(1);
    expect(late[0]?.jobsTotal).toBe(1);
  });
});

// ── ack listener round-trip (paved for FleetAgentAdapter integration) ──

describeOrSkip('onCommandAcked + ackCommand — Phase B integration point', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    __resetReauthForTests();
    __resetCommandListenersForTests();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('fires listener with commandId + status after an agent.execute ack', () => {
    const enqueueResult = enqueueSignedCommand(db, {
      targetDeviceId: 'dev-a',
      commandType: 'agent.execute',
      params: { jobId: 'job-1' },
      createdBy: 'admin',
    });
    if (!enqueueResult.ok) throw new Error('enqueue failed');

    const received: Array<{ commandId: string; status: string }> = [];
    const { onCommandAcked } = require('@process/services/fleetCommands') as {
      onCommandAcked: (fn: (n: { commandId: string; deviceId: string; status: string }) => void) => () => void;
    };
    const unsub = onCommandAcked((n) => received.push({ commandId: n.commandId, status: n.status }));

    const okAck = ackCommand(db, {
      commandId: enqueueResult.commandId,
      deviceId: 'dev-a',
      status: 'succeeded',
      result: { assistantText: 'hello' },
    });
    unsub();
    expect(okAck).toBe(true);
    expect(received).toEqual([{ commandId: enqueueResult.commandId, status: 'succeeded' }]);
  });
});
