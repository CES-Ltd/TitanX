/**
 * @license Apache-2.0
 * Shared types for fleet telemetry aggregation (Phase D Week 1).
 *
 * The report is intentionally compact — a few hundred bytes per device
 * even for a busy day — so a master managing 1,000 slaves still sees
 * tractable payloads on every push.
 */

/**
 * v2.2.1 — Summary of a single ACP agent runtime detected on the
 * slave (e.g. Claude Code CLI, OpenCode, Codex, Qwen). Farm agents
 * execute through an ACP runtime, so this is what determines whether
 * a given farm template (with its required agentType) can run on a
 * given slave. NOT to be confused with LLM API providers — those are
 * consumed by the runtime internally and are not exposed to master.
 *
 * Shape is intentionally minimal: backend id + display name. No
 * `cliPath` (slave-local, useless to master), no version strings
 * (not detected in current AcpDetector).
 */
export type TelemetryRuntimeInfo = {
  /**
   * Backend id matching `AcpBackendAll` (e.g. 'claude', 'opencode',
   * 'codex', 'qwen', 'goose') or 'gemini' for the always-available
   * built-in. Matches against `AgentTemplate.agentType` so the hire
   * modal can warn when a template's required backend isn't on the
   * slave.
   */
  backend: string;
  /** Display label — what the slave's ACP detector reports. */
  name: string;
  /**
   * Whether the CLI binary was found on the slave's PATH at the time
   * of the telemetry push. For 'gemini' (and any future built-ins)
   * this is always true; for CLI-backed runtimes this reflects the
   * `isCliAvailable` probe result.
   */
  cliAvailable: boolean;
};

/** Report pushed by a slave to master for a single time window. */
export type TelemetryReport = {
  /** Inclusive epoch-ms start of the aggregation window. */
  windowStart: number;
  /** Exclusive epoch-ms end of the aggregation window. */
  windowEnd: number;
  /** Sum of cost_events.cost_cents in the window. */
  totalCostCents: number;
  /** COUNT(*) from activity_log in the window. */
  activityCount: number;
  /** Proxy for tool calls — COUNT(*) from cost_events in the window. */
  toolCallCount: number;
  /** COUNT(*) from activity_log where action = 'policy.denied'. */
  policyViolationCount: number;
  /** Whitelisted agents currently configured on the device. */
  agentCount: number;
  /** Top-5 action values by frequency in the window — helps identify hotspots. */
  topActions: Array<{ action: string; count: number }>;
  /**
   * v2.2.1 — ACP agent runtimes detected on the slave. Optional for
   * backward compatibility with pre-v2.2.1 slaves that don't emit this
   * field; the master treats an absent array as "unknown" (not "empty")
   * and skips runtime-based gating in the UI.
   *
   * The v2.2.0 `providers` field (LLM API providers from `model.config`)
   * was misaligned with the farm execution model — farm agents run via
   * ACP CLIs, not direct LLM API calls. The `runtimes` field replaces
   * it; any pre-v2.2.1 slave's `providers` payload is ignored by
   * v2.2.1+ master.
   */
  runtimes?: TelemetryRuntimeInfo[];
};

/**
 * Device-scoped telemetry row as master stores it. The envelope identifies
 * which device sent the report; the report itself carries the aggregates.
 */
export type StoredTelemetryReport = TelemetryReport & {
  deviceId: string;
  receivedAt: number;
};

/** Result of an ingest call — master uses this to tell slave what to do next. */
export type IngestResult = {
  ok: true;
  /** Slave should start the next window here so no overlap + no gap. */
  nextWindowStart: number;
};

/** Fleet-wide rollup for the master admin dashboard. */
export type FleetCostSummary = {
  /** Total cost across ALL devices in the selected window, in cents. */
  totalCostCents: number;
  /** Number of distinct devices that reported cost > 0 in the window. */
  activeDevices: number;
  /** Top-N devices by cost. Sorted desc by costCents. */
  topDevices: Array<{
    deviceId: string;
    hostname?: string;
    costCents: number;
    activityCount: number;
    lastReportAt: number;
  }>;
};

/** Slave-side singleton state for the push loop. */
export type TelemetryState = {
  /** Last window_end we persisted — start here for the next report. */
  lastReportWindowEnd: number;
  /** When the last successful push completed. */
  lastPushAt?: number;
  /** Message from the most recent failed push, if any. */
  lastPushError?: string;
};

/**
 * Per-template adoption summary for the master admin's Fleet Dashboard
 * (Phase E Week 3). "Active" is defined by a recent heartbeat —
 * Phase B's 5-minute staleness window — because the master can't
 * directly query a slave's applied bundle version; it can only
 * verify the slave is online and assume Phase C's full-replace
 * semantics have pushed it every published template.
 */
export type TemplateAdoption = {
  agentId: string;
  name: string;
  agentType: string;
  /**
   * When this template was last flipped to published_to_fleet=1 (or
   * its row last updated, whichever is newer). Surfaced so admins can
   * reason about "I published this 10 min ago, why is adoption 0?".
   */
  publishedAt: number;
  /** Devices whose last_heartbeat_at is within the staleness window. */
  activeDevices: number;
  /** Total enrolled, non-revoked devices. */
  enrolledDevices: number;
};
