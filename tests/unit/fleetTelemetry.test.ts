/**
 * @license Apache-2.0
 * Unit tests for the fleet telemetry service (Phase D Week 1).
 *
 * Uses in-memory SQLite (same pattern as fleetConfig.test.ts — skipped
 * when the native module can't load in the harness).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  buildTelemetryReport,
  getDeviceTelemetry,
  getFleetCostSummary,
  getTelemetryState,
  ingestTelemetryReport,
  setTelemetryState,
} from '@process/services/fleetTelemetry';

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
  runMigrations(driver, 0, 66);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

function seedCostEvent(db: ISqliteDriver, overrides: Partial<{ cost: number; occurredAt: number; userId: string }> = {}): void {
  db.prepare(
    `INSERT INTO cost_events
     (id, user_id, provider, model, input_tokens, output_tokens, cached_input_tokens, cost_cents, billing_type, occurred_at)
     VALUES (?, ?, 'anthropic', 'claude-sonnet', 100, 50, 0, ?, 'metered_api', ?)`
  ).run(
    `ce-${String(Math.random()).slice(2, 8)}`,
    overrides.userId ?? 'u1',
    overrides.cost ?? 42,
    overrides.occurredAt ?? Date.now()
  );
}

function seedActivity(
  db: ISqliteDriver,
  overrides: Partial<{ action: string; createdAt: number; severity: string }> = {}
): void {
  db.prepare(
    `INSERT INTO activity_log (id, user_id, actor_type, actor_id, action, entity_type, entity_id, details, severity, created_at)
     VALUES (?, 'u1', 'user', 'u1', ?, 'test', 'e1', '{}', ?, ?)`
  ).run(
    `al-${String(Math.random()).slice(2, 8)}`,
    overrides.action ?? 'test.action',
    overrides.severity ?? 'info',
    overrides.createdAt ?? Date.now()
  );
}

// ── buildTelemetryReport (slave side) ──────────────────────────────────

describeOrSkip('fleetTelemetry — buildTelemetryReport', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns all-zeros report on a fresh DB', () => {
    const report = buildTelemetryReport(db, 0, Date.now());
    expect(report.totalCostCents).toBe(0);
    expect(report.activityCount).toBe(0);
    expect(report.toolCallCount).toBe(0);
    expect(report.policyViolationCount).toBe(0);
    expect(report.topActions).toEqual([]);
    // agent_gallery is seeded empty at migration time
    expect(report.agentCount).toBe(0);
  });

  it('sums cost_cents within the window', () => {
    const now = 2_000_000;
    seedCostEvent(db, { cost: 100, occurredAt: now - 1000 });
    seedCostEvent(db, { cost: 250, occurredAt: now - 500 });
    // Outside the window — must NOT be counted
    seedCostEvent(db, { cost: 9999, occurredAt: now - 10_000 });
    const report = buildTelemetryReport(db, now - 2000, now);
    expect(report.totalCostCents).toBe(350);
    expect(report.toolCallCount).toBe(2);
  });

  it('respects [windowStart, windowEnd) half-open semantics', () => {
    // Row EXACTLY at windowStart is included; row EXACTLY at windowEnd is excluded.
    seedCostEvent(db, { cost: 10, occurredAt: 1000 });
    seedCostEvent(db, { cost: 20, occurredAt: 2000 });
    const report = buildTelemetryReport(db, 1000, 2000);
    expect(report.totalCostCents).toBe(10);
  });

  it('counts activity log entries in the window', () => {
    const now = 3_000_000;
    seedActivity(db, { action: 'policy.evaluated', createdAt: now - 100 });
    seedActivity(db, { action: 'policy.evaluated', createdAt: now - 200 });
    seedActivity(db, { action: 'tool.invoked', createdAt: now - 50 });
    seedActivity(db, { action: 'tool.invoked', createdAt: now - 999_999 }); // out of window
    const report = buildTelemetryReport(db, now - 500, now);
    expect(report.activityCount).toBe(3);
  });

  it('counts only policy.denied actions as violations', () => {
    const now = 4_000_000;
    seedActivity(db, { action: 'policy.denied', createdAt: now - 100 });
    seedActivity(db, { action: 'policy.denied', createdAt: now - 200 });
    seedActivity(db, { action: 'policy.evaluated', createdAt: now - 150 });
    seedActivity(db, { action: 'tool.invoked', createdAt: now - 150 });
    const report = buildTelemetryReport(db, now - 500, now);
    expect(report.policyViolationCount).toBe(2);
  });

  it('returns top-5 actions by frequency, descending', () => {
    const now = 5_000_000;
    for (let i = 0; i < 4; i++) seedActivity(db, { action: 'tool.invoked', createdAt: now - 10 });
    for (let i = 0; i < 7; i++) seedActivity(db, { action: 'policy.evaluated', createdAt: now - 10 });
    for (let i = 0; i < 2; i++) seedActivity(db, { action: 'agent.spawned', createdAt: now - 10 });
    for (let i = 0; i < 1; i++) seedActivity(db, { action: 'agent.stopped', createdAt: now - 10 });
    for (let i = 0; i < 1; i++) seedActivity(db, { action: 'other.1', createdAt: now - 10 });
    for (let i = 0; i < 1; i++) seedActivity(db, { action: 'other.2', createdAt: now - 10 });

    const report = buildTelemetryReport(db, now - 100, now);
    expect(report.topActions).toHaveLength(5);
    expect(report.topActions[0]).toEqual({ action: 'policy.evaluated', count: 7 });
    expect(report.topActions[1]).toEqual({ action: 'tool.invoked', count: 4 });
  });

  it('defaults untilz to now() when omitted', () => {
    // Sanity: that the 2-arg form returns the same shape as 3-arg.
    const report2 = buildTelemetryReport(db, 0);
    expect(report2).toEqual(expect.objectContaining({ windowStart: 0 }));
    expect(report2.windowEnd).toBeGreaterThan(0);
  });

  it('clamps a negative start to 0', () => {
    const report = buildTelemetryReport(db, -1000, 100);
    expect(report.windowStart).toBe(0);
  });

  it('counts only whitelisted agents for agentCount', () => {
    db.prepare(
      'INSERT INTO agent_gallery (id, user_id, name, agent_type, whitelisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a1', 'u1', 'A', 'worker', 1, Date.now(), Date.now());
    db.prepare(
      'INSERT INTO agent_gallery (id, user_id, name, agent_type, whitelisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a2', 'u1', 'B', 'worker', 1, Date.now(), Date.now());
    db.prepare(
      'INSERT INTO agent_gallery (id, user_id, name, agent_type, whitelisted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('a3', 'u1', 'C', 'worker', 0, Date.now(), Date.now()); // not whitelisted
    const report = buildTelemetryReport(db, 0, Date.now());
    expect(report.agentCount).toBe(2);
  });
});

// ── telemetry state singleton ──────────────────────────────────────────

describeOrSkip('fleetTelemetry — state singleton', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns { lastReportWindowEnd: 0 } on fresh install', () => {
    const state = getTelemetryState(db);
    expect(state.lastReportWindowEnd).toBe(0);
    expect(state.lastPushAt).toBeUndefined();
    expect(state.lastPushError).toBeUndefined();
  });

  it('round-trips a successful push update', () => {
    setTelemetryState(db, { lastReportWindowEnd: 1_700_000_000_000, lastPushAt: 1_700_000_000_001 });
    const state = getTelemetryState(db);
    expect(state.lastReportWindowEnd).toBe(1_700_000_000_000);
    expect(state.lastPushAt).toBe(1_700_000_000_001);
    expect(state.lastPushError).toBeUndefined();
  });

  it('recording an error does NOT advance the window cursor', () => {
    setTelemetryState(db, { lastReportWindowEnd: 1000 });
    setTelemetryState(db, { lastPushError: 'HTTP 500' });
    const state = getTelemetryState(db);
    expect(state.lastReportWindowEnd).toBe(1000); // unchanged
    expect(state.lastPushError).toBe('HTTP 500');
  });
});

// ── ingestTelemetryReport (master side) ────────────────────────────────

describeOrSkip('fleetTelemetry — ingestTelemetryReport', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function sampleReport(overrides: Partial<Parameters<typeof ingestTelemetryReport>[2]> = {}): Parameters<
    typeof ingestTelemetryReport
  >[2] {
    return {
      windowStart: 1000,
      windowEnd: 2000,
      totalCostCents: 100,
      activityCount: 5,
      toolCallCount: 3,
      policyViolationCount: 1,
      agentCount: 2,
      topActions: [{ action: 'tool.invoked', count: 3 }],
      ...overrides,
    };
  }

  it('persists a new report and returns nextWindowStart = windowEnd', () => {
    const result = ingestTelemetryReport(db, 'device-abc', sampleReport());
    expect(result.ok).toBe(true);
    expect(result.nextWindowStart).toBe(2000);

    const row = db.prepare('SELECT * FROM fleet_telemetry_reports WHERE device_id = ?').get('device-abc') as
      | { total_cost_cents: number; activity_count: number; report_payload: string }
      | undefined;
    expect(row?.total_cost_cents).toBe(100);
    expect(row?.activity_count).toBe(5);
    expect(JSON.parse(row?.report_payload ?? '{}')).toEqual({
      topActions: [{ action: 'tool.invoked', count: 3 }],
    });
  });

  it('upsert is idempotent on (device_id, window_end) — retries are safe', () => {
    ingestTelemetryReport(db, 'device-abc', sampleReport({ totalCostCents: 100 }));
    // Same window, but slave retried with slightly updated numbers (shouldn't
    // happen in practice, but the code must be safe regardless).
    ingestTelemetryReport(db, 'device-abc', sampleReport({ totalCostCents: 200 }));

    const rows = db.prepare('SELECT COUNT(*) as c FROM fleet_telemetry_reports WHERE device_id = ?').get('device-abc') as
      | { c: number }
      | undefined;
    expect(rows?.c).toBe(1); // still just one row
    const row = db.prepare('SELECT total_cost_cents FROM fleet_telemetry_reports WHERE device_id = ?').get('device-abc') as
      | { total_cost_cents: number }
      | undefined;
    expect(row?.total_cost_cents).toBe(200); // latest write wins
  });

  it('different windows for same device produce separate rows', () => {
    ingestTelemetryReport(db, 'device-abc', sampleReport({ windowStart: 1000, windowEnd: 2000 }));
    ingestTelemetryReport(db, 'device-abc', sampleReport({ windowStart: 2000, windowEnd: 3000 }));
    const rows = db.prepare('SELECT COUNT(*) as c FROM fleet_telemetry_reports WHERE device_id = ?').get('device-abc') as
      | { c: number }
      | undefined;
    expect(rows?.c).toBe(2);
  });

  it('rejects window with end <= start', () => {
    expect(() => ingestTelemetryReport(db, 'd', sampleReport({ windowStart: 2000, windowEnd: 1000 }))).toThrow(
      /invalid telemetry window/
    );
    expect(() => ingestTelemetryReport(db, 'd', sampleReport({ windowStart: 1000, windowEnd: 1000 }))).toThrow(
      /invalid telemetry window/
    );
  });

  it('rejects windows too far in the future (clock-skew guard)', () => {
    const tenHoursFromNow = Date.now() + 10 * 60 * 60 * 1000;
    expect(() =>
      ingestTelemetryReport(db, 'd', sampleReport({ windowStart: tenHoursFromNow - 1000, windowEnd: tenHoursFromNow }))
    ).toThrow(/future/);
  });
});

// ── getFleetCostSummary (master dashboard) ─────────────────────────────

describeOrSkip('fleetTelemetry — getFleetCostSummary', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function ingest(deviceId: string, windowEnd: number, cost: number, activity = 1): void {
    ingestTelemetryReport(db, deviceId, {
      windowStart: windowEnd - 1000,
      windowEnd,
      totalCostCents: cost,
      activityCount: activity,
      toolCallCount: 0,
      policyViolationCount: 0,
      agentCount: 1,
      topActions: [],
    });
  }

  it('returns zero totals + empty top-devices on a fresh DB', () => {
    const summary = getFleetCostSummary(db, 0, Date.now());
    expect(summary.totalCostCents).toBe(0);
    expect(summary.activeDevices).toBe(0);
    expect(summary.topDevices).toEqual([]);
  });

  it('aggregates costs across devices and windows within range', () => {
    ingest('dev-a', 2000, 100);
    ingest('dev-a', 3000, 150); // same device, different windows
    ingest('dev-b', 2500, 300);
    ingest('dev-c', 100, 999); // OUT of window (window_end=100 <= start=1000)
    const summary = getFleetCostSummary(db, 1000, 4000);
    expect(summary.totalCostCents).toBe(550); // 100 + 150 + 300
    expect(summary.activeDevices).toBe(2); // a and b
  });

  it('topDevices are sorted by cost descending and capped at limit', () => {
    ingest('big', 2000, 500);
    ingest('mid', 2000, 200);
    ingest('small', 2000, 50);
    ingest('tiny', 2000, 5);
    const summary = getFleetCostSummary(db, 0, 3000, 2);
    expect(summary.topDevices).toHaveLength(2);
    expect(summary.topDevices[0]?.deviceId).toBe('big');
    expect(summary.topDevices[0]?.costCents).toBe(500);
    expect(summary.topDevices[1]?.deviceId).toBe('mid');
  });

  it('joins hostname from fleet_enrollments when the device is enrolled', () => {
    db.prepare(
      `INSERT INTO fleet_enrollments
       (device_id, device_pubkey_pem, hostname, os_version, titanx_version, enrolled_at, device_jwt_jti, status, enrollment_token_hash)
       VALUES (?, 'pem', 'laptop-alice', 'darwin', '1.9.32', ?, 'jti', 'enrolled', 'hash')`
    ).run('dev-a', Date.now());
    ingest('dev-a', 2000, 100);
    const summary = getFleetCostSummary(db, 0, 3000);
    expect(summary.topDevices[0]?.hostname).toBe('laptop-alice');
  });

  it('keeps devices with no enrollment row (LEFT JOIN) so revoked devices still show in totals', () => {
    ingest('ghost-dev', 2000, 100);
    const summary = getFleetCostSummary(db, 0, 3000);
    expect(summary.topDevices[0]?.deviceId).toBe('ghost-dev');
    expect(summary.topDevices[0]?.hostname).toBeUndefined();
  });
});

// ── getDeviceTelemetry ─────────────────────────────────────────────────

describeOrSkip('fleetTelemetry — getDeviceTelemetry', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns reports for one device, newest first', () => {
    ingestTelemetryReport(db, 'dev-a', {
      windowStart: 1000,
      windowEnd: 2000,
      totalCostCents: 100,
      activityCount: 1,
      toolCallCount: 0,
      policyViolationCount: 0,
      agentCount: 1,
      topActions: [{ action: 'a', count: 1 }],
    });
    ingestTelemetryReport(db, 'dev-a', {
      windowStart: 2000,
      windowEnd: 3000,
      totalCostCents: 200,
      activityCount: 2,
      toolCallCount: 0,
      policyViolationCount: 0,
      agentCount: 1,
      topActions: [{ action: 'b', count: 2 }],
    });
    ingestTelemetryReport(db, 'dev-b', {
      windowStart: 1500,
      windowEnd: 2500,
      totalCostCents: 999,
      activityCount: 99,
      toolCallCount: 0,
      policyViolationCount: 0,
      agentCount: 1,
      topActions: [],
    });

    const rows = getDeviceTelemetry(db, 'dev-a');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.windowEnd).toBe(3000);
    expect(rows[0]?.topActions).toEqual([{ action: 'b', count: 2 }]);
    expect(rows[1]?.windowEnd).toBe(2000);
  });

  it('respects the limit', () => {
    for (let i = 1; i <= 5; i++) {
      ingestTelemetryReport(db, 'dev', {
        windowStart: i * 100,
        windowEnd: i * 100 + 100,
        totalCostCents: 1,
        activityCount: 1,
        toolCallCount: 0,
        policyViolationCount: 0,
        agentCount: 1,
        topActions: [],
      });
    }
    expect(getDeviceTelemetry(db, 'dev', 2)).toHaveLength(2);
    expect(getDeviceTelemetry(db, 'dev', 100)).toHaveLength(5);
  });

  it('returns [] for an unknown device', () => {
    expect(getDeviceTelemetry(db, 'never-heard-of-this-one')).toEqual([]);
  });

  it('handles corrupt JSON in report_payload without throwing', () => {
    // Insert a row directly with bad JSON
    db.prepare(
      `INSERT INTO fleet_telemetry_reports
       (device_id, window_start, window_end, total_cost_cents, activity_count, tool_call_count,
        policy_violation_count, agent_count, report_payload, received_at)
       VALUES ('corrupt-dev', 0, 1, 0, 0, 0, 0, 0, 'not-json', ?)`
    ).run(Date.now());

    const rows = getDeviceTelemetry(db, 'corrupt-dev');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.topActions).toEqual([]); // fell back gracefully
  });
});
