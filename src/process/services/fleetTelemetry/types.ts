/**
 * @license Apache-2.0
 * Shared types for fleet telemetry aggregation (Phase D Week 1).
 *
 * The report is intentionally compact — a few hundred bytes per device
 * even for a busy day — so a master managing 1,000 slaves still sees
 * tractable payloads on every push.
 */

/**
 * Summary of a single LLM provider configured on the slave. Shape-only
 * — NO API keys, base URLs, or per-model health data. The purpose is
 * to tell the master admin "Machine B has Anthropic + OpenAI enabled
 * with 3 models each" so the hire-farm-agent modal can warn before a
 * farm turn gets dispatched that would just return
 * `no_provider_configured`.
 */
export type TelemetryProviderInfo = {
  /** Provider row id on the slave — stable across pushes. */
  id: string;
  /** Platform identifier (e.g. 'anthropic', 'openai', 'new-api'). */
  platform: string;
  /** Human-readable label the slave admin set. */
  name: string;
  /** Provider enable flag (false = disabled in the slave's UI). */
  enabled: boolean;
  /** Total models configured for this provider. */
  modelCount: number;
  /** Models that are individually enabled (i.e. would be picked for inference). */
  enabledModelCount: number;
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
   * v2.2.0 — LLM providers configured on the slave. Optional for backward
   * compatibility with pre-v2.2.0 slaves that don't emit this field; the
   * master treats an absent array as "unknown" (not "empty") and skips
   * provider-based gating in the UI.
   */
  providers?: TelemetryProviderInfo[];
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
