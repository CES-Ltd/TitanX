/**
 * @license Apache-2.0
 * Database Pruning Service — automatic cleanup of stale data.
 * Prevents unbounded table growth that causes memory/disk exhaustion
 * on long-running desktop sessions (3+ days).
 *
 * Runs every 6 hours, first run 5 minutes after startup.
 */

import type { ISqliteDriver } from './drivers/ISqliteDriver';

/** Retention policies (in milliseconds) */
const RETENTION = {
  activityLog: 30 * 24 * 60 * 60 * 1000, // 30 days
  messages: 14 * 24 * 60 * 60 * 1000, // 14 days inactive
  sprintTasks: 7 * 24 * 60 * 60 * 1000, // 7 days for done/cancelled
  reasoningBank: 14 * 24 * 60 * 60 * 1000, // 14 days unused
  cavemanSavings: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000; // 5 minutes

let _pruneInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Run a single pruning cycle across all tables.
 */
export function pruneStaleData(db: ISqliteDriver): void {
  const now = Date.now();
  const results: Record<string, number> = {};

  try {
    // 1. Activity log — delete entries older than 30 days
    const activityCutoff = now - RETENTION.activityLog;
    const activityResult = db.prepare('DELETE FROM activity_log WHERE created_at < ?').run(activityCutoff);
    results.activity_log = activityResult.changes;
  } catch (err) {
    // Trigger may block delete for recent entries — that's expected
    console.warn('[Pruning] activity_log:', err instanceof Error ? err.message : err);
    results.activity_log = 0;
  }

  try {
    // 2. Messages — delete from conversations with no activity for 14+ days.
    // v2.1.0 [PERF]: was N+1 — fetched the stale conversation list, then
    // ran one DELETE per conversation id. With thousands of stale rows
    // this meant thousands of SQLite round-trips each cycle. Single
    // correlated DELETE deletes them all in one statement.
    const msgCutoff = now - RETENTION.messages;
    const msgResult = db
      .prepare(
        `DELETE FROM messages
         WHERE conversation_id IN (
           SELECT id FROM conversations
           WHERE updated_at < ? AND status != 'running'
         )`
      )
      .run(msgCutoff);
    results.messages = msgResult.changes;
  } catch (err) {
    console.warn('[Pruning] messages:', err instanceof Error ? err.message : err);
    results.messages = 0;
  }

  try {
    // 3. Sprint tasks — delete completed/cancelled older than 7 days
    const sprintCutoff = now - RETENTION.sprintTasks;
    const sprintResult = db
      .prepare(`DELETE FROM sprint_tasks WHERE status IN ('done', 'cancelled') AND updated_at < ?`)
      .run(sprintCutoff);
    results.sprint_tasks = sprintResult.changes;
  } catch (err) {
    console.warn('[Pruning] sprint_tasks:', err instanceof Error ? err.message : err);
    results.sprint_tasks = 0;
  }

  try {
    // 4. Reasoning bank — delete unused trajectories older than 14 days
    const rbCutoff = now - RETENTION.reasoningBank;
    const rbResult = db.prepare('DELETE FROM reasoning_bank WHERE usage_count = 0 AND updated_at < ?').run(rbCutoff);
    results.reasoning_bank = rbResult.changes;
  } catch (err) {
    console.warn('[Pruning] reasoning_bank:', err instanceof Error ? err.message : err);
    results.reasoning_bank = 0;
  }

  try {
    // 5. Caveman savings — delete entries older than 30 days
    const cavemanCutoff = now - RETENTION.cavemanSavings;
    const cavemanResult = db.prepare('DELETE FROM caveman_savings WHERE occurred_at < ?').run(cavemanCutoff);
    results.caveman_savings = cavemanResult.changes;
  } catch (err) {
    console.warn('[Pruning] caveman_savings:', err instanceof Error ? err.message : err);
    results.caveman_savings = 0;
  }

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(
      `[Pruning] Completed: ${Object.entries(results)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')} (total=${total})`
    );
  } else {
    console.log('[Pruning] No stale data to prune');
  }

  // v2.1.0 [PERF]: VACUUM only when a truly large delete happened.
  // The previous >100 threshold triggered VACUUM every cycle on a
  // busy install (activity_log alone easily clears 100 rows/day).
  // Incremental VACUUM holds a write lock for the duration, blocking
  // other DB writers. 10k-row threshold keeps lock contention rare
  // while still reclaiming space when it matters.
  if (total > 10_000) {
    try {
      db.exec('PRAGMA incremental_vacuum(1000)');
    } catch {
      // auto_vacuum might not be enabled — non-critical
    }
  }
}

/**
 * Start the periodic pruning scheduler.
 * First run after 5 minutes, then every 6 hours.
 */
export function startPruningScheduler(db: ISqliteDriver): void {
  if (_pruneInterval) return; // Already running

  console.log('[Pruning] Scheduler started — first run in 5 minutes, then every 6 hours');

  setTimeout(() => {
    pruneStaleData(db);
    _pruneInterval = setInterval(() => pruneStaleData(db), PRUNE_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

/**
 * Stop the pruning scheduler.
 */
export function stopPruningScheduler(): void {
  if (_pruneInterval) {
    clearInterval(_pruneInterval);
    _pruneInterval = null;
    console.log('[Pruning] Scheduler stopped');
  }
}
