/**
 * @license Apache-2.0
 * Structured error types for the agent orchestration runtime.
 *
 * Today, when an agent fails, the system records only `status: 'failed'`
 * and a free-form string. Renderers cannot show meaningful error UI,
 * retry policies cannot make informed decisions, and metrics cannot
 * aggregate by failure kind.
 *
 * AgentFailure is a discriminated union that captures the *reason* an
 * agent turn failed. Each kind carries its own relevant context:
 *   - timeout:             the wake never produced a turnCompleted
 *   - parsing_error:       adapter could not parse the agent's output
 *   - api_error:           LLM provider returned an error response
 *   - policy_violation:    IAM policy denied the action
 *   - impersonation:       cross-agent task mutation blocked
 *   - wake_deadlocked:     retry exhausted, pending wake queue full
 *   - internal:            catch-all for unexpected runtime errors
 *
 * `retryable` is a first-class hint so the heartbeat coordinator can
 * decide whether to auto-retry or escalate without parsing message text.
 */

/** All recognized failure categories.
 *
 * Phase A (v1.9.40) added `fleet_unreachable` + `fleet_timeout` so the
 * future farm-mode adapter (Phase B) has ready-to-use categories without
 * widening the union later. Both are retryable — unreachable typically
 * means transient network, timeout typically means overloaded slave.
 */
export type AgentFailureKind =
  | 'timeout'
  | 'parsing_error'
  | 'api_error'
  | 'policy_violation'
  | 'impersonation'
  | 'wake_deadlocked'
  | 'fleet_unreachable'
  | 'fleet_timeout'
  | 'internal';

/** Structured record of a single agent failure. */
export type AgentFailure = {
  kind: AgentFailureKind;
  /** Human-readable message suitable for logging + UI display. */
  message: string;
  /**
   * Whether the supervisor should automatically retry.
   * Providers retrying is separate; this is the team-orchestrator-level signal.
   */
  retryable: boolean;
  /** Optional structured context (slotId, toolName, HTTP code, etc.). */
  context?: Record<string, unknown>;
  /** Original Error instance if one was thrown. */
  cause?: Error;
  /** When the failure was classified (epoch millis). */
  timestamp: number;
};

// ── Constructors — prefer these over hand-rolling AgentFailure literals ─────

export function timeout(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'timeout', message, retryable: true, context, timestamp: Date.now() };
}

export function parsingError(message: string, cause?: Error, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'parsing_error', message, retryable: false, cause, context, timestamp: Date.now() };
}

export function apiError(message: string, cause?: Error, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'api_error', message, retryable: true, cause, context, timestamp: Date.now() };
}

export function policyViolation(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'policy_violation', message, retryable: false, context, timestamp: Date.now() };
}

export function impersonation(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'impersonation', message, retryable: false, context, timestamp: Date.now() };
}

export function wakeDeadlocked(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'wake_deadlocked', message, retryable: false, context, timestamp: Date.now() };
}

export function internalError(message: string, cause?: Error, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'internal', message, retryable: true, cause, context, timestamp: Date.now() };
}

/** Farm slave couldn't be reached at all — transient, usually network. */
export function fleetUnreachable(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'fleet_unreachable', message, retryable: true, context, timestamp: Date.now() };
}

/** Farm slave acked the command but didn't complete in time. Retryable. */
export function fleetTimeout(message: string, context?: Record<string, unknown>): AgentFailure {
  return { kind: 'fleet_timeout', message, retryable: true, context, timestamp: Date.now() };
}

/**
 * Normalize an arbitrary caught value into an AgentFailure.
 * Used when wrapping errors at orchestration boundaries — ensures every
 * downstream consumer gets a structured record regardless of what was thrown.
 */
export function fromUnknown(err: unknown, fallbackKind: AgentFailureKind = 'internal'): AgentFailure {
  if (err instanceof Error) {
    return {
      kind: fallbackKind,
      message: err.message,
      retryable:
        fallbackKind === 'timeout' ||
        fallbackKind === 'api_error' ||
        fallbackKind === 'internal' ||
        fallbackKind === 'fleet_unreachable' ||
        fallbackKind === 'fleet_timeout',
      cause: err,
      timestamp: Date.now(),
    };
  }
  return {
    kind: fallbackKind,
    message: String(err),
    retryable: fallbackKind === 'timeout' || fallbackKind === 'api_error' || fallbackKind === 'internal',
    timestamp: Date.now(),
  };
}

/** True if the failure kind is generally safe to retry automatically. */
export function isRetryable(failure: AgentFailure): boolean {
  return failure.retryable;
}
