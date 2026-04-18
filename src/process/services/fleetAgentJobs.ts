/**
 * @license Apache-2.0
 * Read-only query helpers for the fleet_agent_jobs table (Phase B,
 * v1.10.0).
 *
 * This table is written to from TWO places:
 *   - master: FleetAgentAdapter records queued → dispatched → completed
 *   - slave: farmExecutor records running → completed/failed/timeout
 *     (mirror copy on the slave for local telemetry aggregation)
 *
 * Admin UI hits this module on the master side for the FarmDashboard
 * and device-drill-down. A single module rather than splitting across
 * master/slave because the schema is identical on both sides.
 */

import type { ISqliteDriver } from './database/drivers/ISqliteDriver';

export type FarmJobStatus = 'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'timeout';

export type FarmJobRow = {
  id: string;
  deviceId: string;
  teamId: string;
  agentSlotId: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  status: FarmJobStatus;
  error: string | null;
  enqueuedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
};

export type FarmJobSummary = {
  deviceId: string;
  jobsTotal: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsTimeout: number;
  avgLatencyMs: number;
  lastJobAt: number | null;
};

/**
 * List recent jobs across all devices, newest first. Intentionally
 * simple — no rich filter/pagination UI on v1.10.0. Filters can be
 * layered on once the dashboard proves the baseline useful.
 */
export function listFarmJobs(db: ISqliteDriver, limit: number = 100): FarmJobRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM fleet_agent_jobs
       ORDER BY enqueued_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    id: string;
    device_id: string;
    team_id: string;
    agent_slot_id: string;
    request_payload: string;
    response_payload: string | null;
    status: FarmJobStatus;
    error: string | null;
    enqueued_at: number;
    dispatched_at: number | null;
    completed_at: number | null;
  }>;
  return rows.map(toRow);
}

/** Jobs for a single device — drill-down. */
export function listFarmJobsForDevice(db: ISqliteDriver, deviceId: string, limit: number = 50): FarmJobRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM fleet_agent_jobs
       WHERE device_id = ?
       ORDER BY enqueued_at DESC
       LIMIT ?`
    )
    .all(deviceId, limit) as Array<{
    id: string;
    device_id: string;
    team_id: string;
    agent_slot_id: string;
    request_payload: string;
    response_payload: string | null;
    status: FarmJobStatus;
    error: string | null;
    enqueued_at: number;
    dispatched_at: number | null;
    completed_at: number | null;
  }>;
  return rows.map(toRow);
}

/**
 * Per-device summary of farm job activity over a time window.
 * avgLatencyMs = mean of (completed_at - enqueued_at) across completed
 * jobs; 0 if no completed jobs. Window is inclusive-start, exclusive-end.
 */
export function summarizeFarmJobs(db: ISqliteDriver, windowStart: number, windowEnd: number): FarmJobSummary[] {
  const rows = db
    .prepare(
      `SELECT
         device_id,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timedout,
         AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL
                  THEN completed_at - enqueued_at
                  ELSE NULL END) AS avg_latency,
         MAX(enqueued_at) AS last_at
       FROM fleet_agent_jobs
       WHERE enqueued_at >= ? AND enqueued_at < ?
       GROUP BY device_id
       ORDER BY total DESC`
    )
    .all(windowStart, windowEnd) as Array<{
    device_id: string;
    total: number;
    completed: number;
    failed: number;
    timedout: number;
    avg_latency: number | null;
    last_at: number | null;
  }>;
  return rows.map((r) => ({
    deviceId: r.device_id,
    jobsTotal: r.total,
    jobsCompleted: r.completed,
    jobsFailed: r.failed,
    jobsTimeout: r.timedout,
    avgLatencyMs: r.avg_latency ?? 0,
    lastJobAt: r.last_at,
  }));
}

function toRow(r: {
  id: string;
  device_id: string;
  team_id: string;
  agent_slot_id: string;
  request_payload: string;
  response_payload: string | null;
  status: FarmJobStatus;
  error: string | null;
  enqueued_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
}): FarmJobRow {
  return {
    id: r.id,
    deviceId: r.device_id,
    teamId: r.team_id,
    agentSlotId: r.agent_slot_id,
    requestPayload: safeParseObj(r.request_payload),
    responsePayload: r.response_payload == null ? null : safeParseObj(r.response_payload),
    status: r.status,
    error: r.error,
    enqueuedAt: r.enqueued_at,
    dispatchedAt: r.dispatched_at,
    completedAt: r.completed_at,
  };
}

function safeParseObj(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v != null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
