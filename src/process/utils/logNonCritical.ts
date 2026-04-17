/**
 * @license Apache-2.0
 * Helper for logging errors in non-critical code paths.
 *
 * Motivation: the codebase contains 1,000+ `catch {}` and `catch (_)`
 * blocks that silently swallow errors in "non-critical" paths like
 * telemetry, audit log writes, and live-event emission. When something
 * actually breaks — a DB driver crash, a missing index, a type error
 * inside a listener — the symptom is an invisible feature gap, with
 * zero signal for operators to diagnose.
 *
 * This helper replaces the empty catch pattern:
 *
 *   try { await activityLog.logActivity(...) } catch {}
 *
 * With an observable one:
 *
 *   try { await activityLog.logActivity(...) }
 *   catch (e) { logNonCritical('activity-log', e); }
 *
 * Failures show up in stderr with a category label and become counted
 * in the returned stats so operators can spot unexpected spikes.
 */

/** Counters of non-critical failures, bucketed by context label. */
const _failureCounts = new Map<string, number>();
/** Last error message per context, used to suppress repeated log spam. */
const _lastMessage = new Map<string, string>();

/**
 * Log a non-critical error and increment its counter.
 *
 * @param context - Short stable label (e.g. 'activity-log', 'telemetry').
 *                  Used for bucketing; keep it constant within a call site.
 * @param error - The caught value. Non-Error values are coerced to string.
 */
export function logNonCritical(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const count = (_failureCounts.get(context) ?? 0) + 1;
  _failureCounts.set(context, count);

  // De-dup: only log when the message changes OR every 100 occurrences,
  // whichever comes first. This catches new failures while preventing
  // logger I/O storms when a dependency is persistently down.
  const previous = _lastMessage.get(context);
  if (previous !== message || count % 100 === 0) {
    _lastMessage.set(context, message);
    console.warn(`[non-critical:${context}] ${message} (occurrences: ${count})`);
  }
}

/**
 * Snapshot current failure counts. Consumed by diagnostics/telemetry.
 * Returns a copy so callers can't mutate the internal state.
 */
export function getNonCriticalFailureCounts(): Record<string, number> {
  return Object.fromEntries(_failureCounts);
}

/**
 * Reset counters + last-message cache. Primarily for tests.
 */
export function _resetNonCriticalLogForTests(): void {
  _failureCounts.clear();
  _lastMessage.clear();
}
