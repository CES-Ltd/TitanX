/**
 * @license Apache-2.0
 * Fleet telemetry aggregation service (Phase D Week 1).
 *
 * Two symmetric roles, mirror of fleetConfig:
 *   - Slave: `buildTelemetryReport(db, since)` aggregates local
 *     activity_log + cost_events + agent_gallery into a compact JSON
 *     report. `getTelemetryState` / `setTelemetryState` persist the
 *     push-loop cursor so windows don't overlap across restarts.
 *   - Master: `ingestTelemetryReport(db, deviceId, report)` upserts a
 *     row keyed on (device_id, window_end) — idempotent so a slave can
 *     retry a push without double-counting. Query helpers
 *     (`getFleetCostSummary`, `getDeviceTelemetry`) feed the admin
 *     dashboard shipping in Week 3.
 *
 * Sizing: one report is ~200–500 bytes post-JSON; 1,000 slaves pushing
 * every 6 hours is ~100 KB/push × 4 pushes/day ≈ 400 KB/day of master
 * ingest. Cheap at any reasonable fleet size.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logNonCritical } from '@process/utils/logNonCritical';
import type {
  FleetCostSummary,
  IngestResult,
  StoredTelemetryReport,
  TelemetryReport,
  TelemetryState,
  TemplateAdoption,
} from './types';

const TOP_ACTIONS_LIMIT = 5;
const DEFAULT_TOP_DEVICES_LIMIT = 10;

// ── Slave: build report ─────────────────────────────────────────────────

/**
 * Aggregate the slave's local tables into a telemetry report covering
 * the window [since, until). If `until` is omitted, defaults to now().
 *
 * Reads are best-effort: if any source table is missing (e.g. on a very
 * fresh install before some seed data lands) the missing field defaults
 * to 0 instead of crashing the push.
 */
export function buildTelemetryReport(
  db: ISqliteDriver,
  since: number,
  until: number = Date.now(),
  /**
   * v2.2.1 — ACP runtime summary fetched by the caller from
   * `acpDetector.getDetectedAgents()`. Kept out of this fn's body
   * because the detector is async-initialized elsewhere and callers
   * (slavePush, unit tests) prefer a pure sync signature. Pass
   * `undefined` (or omit) on paths where runtime detection isn't
   * available — the report's `runtimes` field just stays absent,
   * which the master treats as "unknown" rather than "empty".
   */
  runtimes?: import('./types').TelemetryRuntimeInfo[]
): TelemetryReport {
  const windowStart = Math.max(0, since);
  const windowEnd = Math.max(windowStart, until);

  const totalCostCents = safeCount(db, () => {
    const row = db
      .prepare(
        'SELECT COALESCE(SUM(cost_cents), 0) as total FROM cost_events WHERE occurred_at >= ? AND occurred_at < ?'
      )
      .get(windowStart, windowEnd) as { total: number } | undefined;
    return row?.total ?? 0;
  });

  const activityCount = safeCount(db, () => {
    const row = db
      .prepare('SELECT COUNT(*) as c FROM activity_log WHERE created_at >= ? AND created_at < ?')
      .get(windowStart, windowEnd) as { c: number } | undefined;
    return row?.c ?? 0;
  });

  const toolCallCount = safeCount(db, () => {
    const row = db
      .prepare('SELECT COUNT(*) as c FROM cost_events WHERE occurred_at >= ? AND occurred_at < ?')
      .get(windowStart, windowEnd) as { c: number } | undefined;
    return row?.c ?? 0;
  });

  const policyViolationCount = safeCount(db, () => {
    const row = db
      .prepare(
        "SELECT COUNT(*) as c FROM activity_log WHERE action = 'policy.denied' AND created_at >= ? AND created_at < ?"
      )
      .get(windowStart, windowEnd) as { c: number } | undefined;
    return row?.c ?? 0;
  });

  const agentCount = safeCount(db, () => {
    const row = db.prepare('SELECT COUNT(*) as c FROM agent_gallery WHERE whitelisted = 1').get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  });

  const topActions = safeTopActions(db, windowStart, windowEnd);

  return {
    windowStart,
    windowEnd,
    totalCostCents,
    activityCount,
    toolCallCount,
    policyViolationCount,
    agentCount,
    topActions,
    runtimes,
  };
}

function safeCount(db: ISqliteDriver, fn: () => number): number {
  try {
    return fn();
  } catch (e) {
    logNonCritical('fleet.telemetry.count-query', e);
    return 0;
  }
}

function safeTopActions(
  db: ISqliteDriver,
  windowStart: number,
  windowEnd: number
): Array<{ action: string; count: number }> {
  try {
    const rows = db
      .prepare(
        `SELECT action, COUNT(*) as c
         FROM activity_log
         WHERE created_at >= ? AND created_at < ?
         GROUP BY action
         ORDER BY c DESC
         LIMIT ${String(TOP_ACTIONS_LIMIT)}`
      )
      .all(windowStart, windowEnd) as Array<{ action: string; c: number }>;
    return rows.map((r) => ({ action: r.action, count: r.c }));
  } catch (e) {
    logNonCritical('fleet.telemetry.top-actions-query', e);
    return [];
  }
}

// ── Slave: state singleton ──────────────────────────────────────────────

/** Current slave-side telemetry cursor. Never throws — defaults on any error. */
export function getTelemetryState(db: ISqliteDriver): TelemetryState {
  try {
    const row = db
      .prepare('SELECT last_report_window_end, last_push_at, last_push_error FROM fleet_telemetry_state WHERE id = 1')
      .get() as
      | { last_report_window_end: number; last_push_at: number | null; last_push_error: string | null }
      | undefined;
    if (!row) {
      return { lastReportWindowEnd: 0 };
    }
    return {
      lastReportWindowEnd: row.last_report_window_end,
      lastPushAt: row.last_push_at ?? undefined,
      lastPushError: row.last_push_error ?? undefined,
    };
  } catch (e) {
    logNonCritical('fleet.telemetry.state-read', e);
    return { lastReportWindowEnd: 0 };
  }
}

/**
 * Persist slave-side cursor + push metadata. Called after a successful
 * master ack (advances lastReportWindowEnd, clears lastPushError) or
 * after a failure (records lastPushError but leaves lastReportWindowEnd
 * untouched so the next push re-tries the same window).
 *
 * Merge semantics use `in` rather than nullish coalescing. Earlier versions
 * used `patch.lastPushError ?? existing.lastPushError`, which fell through
 * to the old value when callers passed `undefined` to clear the error —
 * meaning an error set once could never be cleared. That made Machine B's
 * UI report a stale "HTTP 401" even after push had recovered to 200 OK.
 */
export function setTelemetryState(db: ISqliteDriver, patch: Partial<TelemetryState> & { updatedAt?: number }): void {
  const now = patch.updatedAt ?? Date.now();
  // INSERT OR REPLACE keeps the singleton at id=1 regardless of prior state.
  const existing = getTelemetryState(db);
  // "Field is in patch" check — distinguishes "caller wants to clear"
  // from "caller didn't mention this field". A value of undefined
  // passed explicitly now correctly clears the field.
  const next: TelemetryState = {
    lastReportWindowEnd:
      'lastReportWindowEnd' in patch ? (patch.lastReportWindowEnd ?? 0) : existing.lastReportWindowEnd,
    lastPushAt: 'lastPushAt' in patch ? patch.lastPushAt : existing.lastPushAt,
    lastPushError: 'lastPushError' in patch ? patch.lastPushError : existing.lastPushError,
  };
  try {
    db.prepare(
      `INSERT OR REPLACE INTO fleet_telemetry_state
       (id, last_report_window_end, last_push_at, last_push_error, updated_at)
       VALUES (1, ?, ?, ?, ?)`
    ).run(next.lastReportWindowEnd, next.lastPushAt ?? null, next.lastPushError ?? null, now);
  } catch (e) {
    logNonCritical('fleet.telemetry.state-write', e);
  }
}

// ── Master: ingest ──────────────────────────────────────────────────────

/**
 * Persist a report pushed by a slave. Upsert on (device_id, window_end)
 * makes replays harmless — a slave retrying a push gets the same row
 * updated, not duplicated.
 *
 * Rejects nonsensical windows (end <= start, future windows too far out).
 * Returns `nextWindowStart = report.windowEnd` so slaves can advance
 * their cursor atomically on the response.
 */
export function ingestTelemetryReport(db: ISqliteDriver, deviceId: string, report: TelemetryReport): IngestResult {
  if (report.windowEnd <= report.windowStart) {
    throw new Error('invalid telemetry window: end must be > start');
  }
  // Guard against clock skew pushing a window way into the future.
  // 1 hour grace is enough for reasonable NTP drift.
  const oneHourFromNow = Date.now() + 60 * 60 * 1000;
  if (report.windowEnd > oneHourFromNow) {
    throw new Error('invalid telemetry window: end is too far in the future');
  }

  const payload = JSON.stringify({
    topActions: report.topActions,
    // v2.2.1 — runtime summary lives inside the JSON blob so no schema
    // migration is required. Omitted when the slave is pre-v2.2.1.
    // NB: v2.2.0's `providers` field was wrong semantically (LLM API
    // providers instead of ACP runtimes) and is ignored on read.
    runtimes: report.runtimes,
  });

  db.prepare(
    `INSERT OR REPLACE INTO fleet_telemetry_reports
     (device_id, window_start, window_end, total_cost_cents, activity_count, tool_call_count,
      policy_violation_count, agent_count, report_payload, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    deviceId,
    report.windowStart,
    report.windowEnd,
    report.totalCostCents,
    report.activityCount,
    report.toolCallCount,
    report.policyViolationCount,
    report.agentCount,
    payload,
    Date.now()
  );

  return { ok: true, nextWindowStart: report.windowEnd };
}

// ── Master: query helpers (dashboard) ───────────────────────────────────

/**
 * Fleet-wide rollup across all devices for the given window. Powers the
 * master admin dashboard's top strip + Top-N devices table.
 *
 * Joins fleet_enrollments (Phase B) to surface hostname in the output —
 * the dashboard renders "laptop-alice" instead of raw device fingerprints.
 * LEFT JOIN so devices whose enrollment row was revoked still show up in
 * cost totals; their hostname just shows as undefined.
 */
export function getFleetCostSummary(
  db: ISqliteDriver,
  windowStart: number,
  windowEnd: number,
  topDevicesLimit: number = DEFAULT_TOP_DEVICES_LIMIT
): FleetCostSummary {
  const totalsRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_cents), 0) as total,
              COUNT(DISTINCT device_id) as devices
       FROM fleet_telemetry_reports
       WHERE window_end > ? AND window_end <= ?`
    )
    .get(windowStart, windowEnd) as { total: number; devices: number } | undefined;

  const topDeviceRows = db
    .prepare(
      `SELECT ftr.device_id,
              fe.hostname,
              SUM(ftr.total_cost_cents) as cost_cents,
              SUM(ftr.activity_count) as activity_count,
              MAX(ftr.received_at) as last_report_at
       FROM fleet_telemetry_reports ftr
       LEFT JOIN fleet_enrollments fe ON fe.device_id = ftr.device_id
       WHERE ftr.window_end > ? AND ftr.window_end <= ?
       GROUP BY ftr.device_id
       ORDER BY cost_cents DESC
       LIMIT ?`
    )
    .all(windowStart, windowEnd, topDevicesLimit) as Array<{
    device_id: string;
    hostname: string | null;
    cost_cents: number;
    activity_count: number;
    last_report_at: number;
  }>;

  return {
    totalCostCents: totalsRow?.total ?? 0,
    activeDevices: totalsRow?.devices ?? 0,
    topDevices: topDeviceRows.map((r) => ({
      deviceId: r.device_id,
      hostname: r.hostname ?? undefined,
      costCents: r.cost_cents,
      activityCount: r.activity_count,
      lastReportAt: r.last_report_at,
    })),
  };
}

/** All stored reports for one device, newest first. Drill-down view. */
export function getDeviceTelemetry(db: ISqliteDriver, deviceId: string, limit: number = 50): StoredTelemetryReport[] {
  const rows = db
    .prepare(
      `SELECT * FROM fleet_telemetry_reports
       WHERE device_id = ?
       ORDER BY window_end DESC
       LIMIT ?`
    )
    .all(deviceId, limit) as Array<{
    device_id: string;
    window_start: number;
    window_end: number;
    total_cost_cents: number;
    activity_count: number;
    tool_call_count: number;
    policy_violation_count: number;
    agent_count: number;
    report_payload: string;
    received_at: number;
  }>;

  return rows.map((r) => {
    let topActions: Array<{ action: string; count: number }> = [];
    let runtimes: import('./types').TelemetryRuntimeInfo[] | undefined;
    try {
      const parsed = JSON.parse(r.report_payload) as {
        topActions?: Array<{ action: string; count: number }>;
        runtimes?: import('./types').TelemetryRuntimeInfo[];
      };
      topActions = parsed.topActions ?? [];
      runtimes = parsed.runtimes;
    } catch {
      // Corrupt payload — surface the numeric aggregates anyway.
    }
    return {
      deviceId: r.device_id,
      windowStart: r.window_start,
      windowEnd: r.window_end,
      totalCostCents: r.total_cost_cents,
      activityCount: r.activity_count,
      toolCallCount: r.tool_call_count,
      policyViolationCount: r.policy_violation_count,
      agentCount: r.agent_count,
      topActions,
      runtimes,
      receivedAt: r.received_at,
    };
  });
}

/**
 * v2.2.1 — return the most recent ACP-runtime summary per device,
 * keyed by deviceId. Powers the master-side HireFarmAgentModal's
 * runtime badges + agentType-mismatch warning without requiring a
 * per-device drill-down.
 *
 * Returns an empty map on any query failure (best-effort — the UI
 * still renders devices, it just can't gate on runtimes).
 */
export function getLatestRuntimesByDevice(db: ISqliteDriver): Map<string, import('./types').TelemetryRuntimeInfo[]> {
  const map = new Map<string, import('./types').TelemetryRuntimeInfo[]>();
  try {
    // Single query: latest report per device via GROUP BY + MAX(window_end).
    // A correlated subquery would be clearer but slower at scale.
    const rows = db
      .prepare(
        `SELECT t.device_id, t.report_payload
         FROM fleet_telemetry_reports t
         INNER JOIN (
           SELECT device_id, MAX(window_end) as max_we
           FROM fleet_telemetry_reports
           GROUP BY device_id
         ) latest ON latest.device_id = t.device_id AND latest.max_we = t.window_end`
      )
      .all() as Array<{ device_id: string; report_payload: string }>;

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.report_payload) as {
          runtimes?: import('./types').TelemetryRuntimeInfo[];
        };
        if (Array.isArray(parsed.runtimes)) {
          map.set(row.device_id, parsed.runtimes);
        }
      } catch {
        // Corrupt payload — skip this device.
      }
    }
  } catch (e) {
    logNonCritical('fleet.telemetry.latest-runtimes-query', e);
  }
  return map;
}

// ── Master: agent-template adoption (Phase E Week 3) ────────────────────

/**
 * Active-device staleness threshold. Phase B heartbeat cadence is 60s;
 * 5 minutes gives a device one missed heartbeat of slack before it's
 * considered absent from the fleet for adoption purposes.
 */
const HEARTBEAT_STALE_AFTER_MS = 5 * 60_000;

/**
 * Per-template adoption rollup for the master admin dashboard
 * (Phase E Week 3).
 *
 * Answers: "How many of my enrolled slaves currently have this
 * master-pushed template installed?"
 *
 * Because Phase C's bundle is full-replace + Phase E publishes templates
 * inside that bundle, the correct answer is:
 *
 *   activeDevices  = enrollments with a heartbeat within the last 5 min
 *                    (i.e. devices we're confident have applied the
 *                    latest bundle)
 *   enrolledDevices = all non-revoked enrollments (includes stale ones
 *                     that will catch up on next reconnect)
 *
 * We don't need a per-device applied-version column — the full-replace
 * guarantee means "recently-online => has every published template".
 */
export function listPublishedTemplatesWithAdoption(db: ISqliteDriver): TemplateAdoption[] {
  const now = Date.now();
  const staleBefore = now - HEARTBEAT_STALE_AFTER_MS;

  // Enrollment counts — one query, cached in vars so a 1000-slave fleet
  // doesn't fan out to 1000 N+1 lookups per template row.
  const enrollRow = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'enrolled' THEN 1 ELSE 0 END) as enrolled,
         SUM(CASE WHEN status = 'enrolled' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at > ? THEN 1 ELSE 0 END) as active
       FROM fleet_enrollments`
    )
    .get(staleBefore) as { enrolled: number | null; active: number | null } | undefined;

  const enrolledDevices = enrollRow?.enrolled ?? 0;
  const activeDevices = enrollRow?.active ?? 0;

  // Pull published templates. `source != 'master'` guards against a
  // slave-turned-master re-broadcasting its IT-pushed templates.
  const rows = db
    .prepare(
      `SELECT id, name, agent_type, updated_at
       FROM agent_gallery
       WHERE published_to_fleet = 1 AND (source IS NULL OR source != 'master')
       ORDER BY name ASC`
    )
    .all() as Array<{ id: string; name: string; agent_type: string; updated_at: number }>;

  return rows.map((r) => ({
    agentId: r.id,
    name: r.name,
    agentType: r.agent_type,
    publishedAt: r.updated_at,
    activeDevices,
    enrolledDevices,
  }));
}
