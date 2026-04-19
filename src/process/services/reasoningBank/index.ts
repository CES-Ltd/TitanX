/**
 * ReasoningBank — trajectory storage and replay for agent execution.
 *
 * Stores entire execution paths (tool calls + results) for successful tasks.
 * When a similar task is encountered, retrieves the trajectory and suggests
 * replay instead of reasoning from scratch. Saves ~32% tokens on repeated patterns.
 *
 * Pattern: RETRIEVE → JUDGE → DISTILL (from Ruflo/LangChain DeepAgents)
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type TrajectoryStep = {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
};

export type Trajectory = {
  id: string;
  trajectoryHash: string;
  taskDescription: string;
  steps: TrajectoryStep[];
  successScore: number;
  usageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type TrajectoryInput = {
  taskDescription: string;
  steps: TrajectoryStep[];
  successScore: number;
  /**
   * v2.5.0 Phase B2 — mark this as a failure trajectory so the
   * distillation pass can extract avoidance rules. Defaults to
   * false (preferred path). Pre-v2.5 only stored successes; failure
   * capture lets agents learn from the fleet's mistakes too.
   */
  failurePattern?: boolean;
  /**
   * v2.5.0 final — workspace scope. Tagged at capture time so
   * retrieval can filter by the requesting agent's workspace,
   * slave push can partition by workspace, and master's dream
   * pass can consolidate per-workspace clusters. NULL / undefined =
   * "fleet-wide" (available to every workspace). Pass the team's
   * workspace path or a stable tenant id here.
   */
  workspaceId?: string;
};

/** Hash a trajectory for deduplication. Uses task description + tool sequence. */
function hashTrajectory(taskDescription: string, steps: TrajectoryStep[]): string {
  const normalized = `${taskDescription.toLowerCase().trim()}|${steps.map((s) => `${s.toolName}:${JSON.stringify(s.args)}`).join('|')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Store a successful execution trajectory.
 * If a trajectory with the same hash exists, increments usage count.
 */
export function storeTrajectory(db: ISqliteDriver, input: TrajectoryInput): string {
  const hash = hashTrajectory(input.taskDescription, input.steps);
  const existing = db.prepare('SELECT id, usage_count FROM reasoning_bank WHERE trajectory_hash = ?').get(hash) as
    | { id: string; usage_count: number }
    | undefined;

  if (existing) {
    db.prepare('UPDATE reasoning_bank SET usage_count = ?, success_score = ?, updated_at = ? WHERE id = ?').run(
      existing.usage_count + 1,
      Math.max(input.successScore, 0),
      Date.now(),
      existing.id
    );
    console.log(`[ReasoningBank] Updated trajectory ${existing.id} (usage: ${String(existing.usage_count + 1)})`);
    return existing.id;
  }

  const id = crypto.randomUUID();
  // v2.5.0 Phase B2 — stamp failure_pattern = 1 when the caller
  // flagged this as a failed turn. Default 0 preserves existing
  // behavior for v2.4.x callers and other non-turn writers.
  // v2.5.0 final — stamp workspace_id when present so the rest of
  // the learning pipeline (slave push → master consolidation →
  // slave retrieval) can honor tenant boundaries. Older DBs that
  // haven't run migration v72 lack the workspace_id column; fall
  // back to the pre-workspace shape on those.
  try {
    db.prepare(
      `INSERT INTO reasoning_bank (id, trajectory_hash, task_description, trajectory, success_score, usage_count, failure_pattern, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(
      id,
      hash,
      input.taskDescription,
      JSON.stringify(input.steps),
      input.successScore,
      input.failurePattern ? 1 : 0,
      input.workspaceId ?? null,
      Date.now(),
      Date.now()
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column: workspace_id/i.test(msg)) {
      db.prepare(
        `INSERT INTO reasoning_bank (id, trajectory_hash, task_description, trajectory, success_score, usage_count, failure_pattern, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        id,
        hash,
        input.taskDescription,
        JSON.stringify(input.steps),
        input.successScore,
        input.failurePattern ? 1 : 0,
        Date.now(),
        Date.now()
      );
    } else {
      throw e;
    }
  }

  console.log(
    `[ReasoningBank] Stored new ${input.failurePattern ? 'failure' : 'success'} trajectory ${id} (${String(input.steps.length)} steps, score: ${String(input.successScore)})`
  );
  return id;
}

/**
 * RETRIEVE: Find similar trajectories for a given task description.
 * Uses simple keyword matching (future: semantic search with HNSW).
 *
 * v2.5.0 final — optional `workspaceId` filter. When provided, only
 * trajectories whose `workspace_id` matches OR whose `workspace_id`
 * is NULL (fleet-wide) are eligible. This enforces tenant isolation
 * while still letting shared fleet knowledge (un-scoped trajectories)
 * enrich every workspace. Omit the param to match historical behavior
 * (return everything).
 */
export function findSimilarTrajectories(
  db: ISqliteDriver,
  taskDescription: string,
  limit: number = 3,
  workspaceId?: string
): Trajectory[] {
  // Simple keyword matching — extract key terms and search
  const keywords = taskDescription
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  // Build LIKE clauses for each keyword
  const conditions = keywords.map(() => 'task_description LIKE ?').join(' OR ');
  const params: unknown[] = keywords.map((k) => `%${k}%`);

  // v2.5.0 final — workspace scope filter. Match rows tagged with the
  // same workspace OR rows with no workspace tag at all (fleet-wide).
  // Older DBs lack the column; catch and fall back to the unfiltered
  // query.
  let workspaceClause = '';
  if (workspaceId) {
    workspaceClause = ' AND (workspace_id IS NULL OR workspace_id = ?)';
    params.push(workspaceId);
  }
  params.push(limit);

  // v2.5.0 Phase A3 — explicit fleet-consolidated preference. Fleet-
  // wisdom (source_tag='fleet_consolidated', aggregated across many
  // devices) should beat a locally-repeated pattern of similar match
  // quality. The pre-v2.5 ordering was `usage_count DESC, success_score
  // DESC` and relied on the consolidated row's usage_count being a
  // sum-of-all-devices (and therefore usually larger than local). But
  // a slave that repeats one local pattern 50 times could outrank a
  // fleet pattern seen 10 times on 5 devices — exactly the opposite of
  // what we want. Sort by source_tag first, then the existing keys.
  try {
    const rows = db
      .prepare(
        `SELECT * FROM reasoning_bank
         WHERE (${conditions}) AND success_score >= 0.7${workspaceClause}
         ORDER BY (source_tag = 'fleet_consolidated') DESC, usage_count DESC, success_score DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToTrajectory);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!workspaceId || !/no such column: workspace_id/i.test(msg)) throw e;
    // Fallback for pre-v72 DBs: drop the workspace clause entirely.
    const fallbackRows = db
      .prepare(
        `SELECT * FROM reasoning_bank
         WHERE (${conditions}) AND success_score >= 0.7
         ORDER BY (source_tag = 'fleet_consolidated') DESC, usage_count DESC, success_score DESC
         LIMIT ?`
      )
      .all(...keywords.map((k) => `%${k}%`), limit) as Array<Record<string, unknown>>;
    return fallbackRows.map(rowToTrajectory);
  }
}

/**
 * v2.5.0 Phase B1 — consumption feedback. Called when a retrieved
 * trajectory actually gets used in a turn (by the retrieval caller
 * in the wake cycle). Increments two counters:
 *   - consumption_count — always; "this slave used it"
 *   - consumption_success_count — only if the turn that consumed it
 *     ended with success_score >= 0.7; "this slave used it AND the
 *     turn ultimately succeeded"
 *
 * The counters piggyback to master on the next learning push so
 * master's dream pass can re-rank by real-world adoption, not just
 * the original ingestion signal. Fire-and-forget — logging a usage
 * never fails the caller's hot path.
 */
export function recordTrajectoryConsumed(db: ISqliteDriver, trajectoryId: string, turnSucceeded: boolean): void {
  try {
    if (turnSucceeded) {
      db.prepare(
        'UPDATE reasoning_bank SET consumption_count = consumption_count + 1, consumption_success_count = consumption_success_count + 1 WHERE id = ?'
      ).run(trajectoryId);
    } else {
      db.prepare('UPDATE reasoning_bank SET consumption_count = consumption_count + 1 WHERE id = ?').run(trajectoryId);
    }
  } catch {
    /* best-effort telemetry; never break the wake cycle */
  }
}

/**
 * v2.5.0 Phase B1 — drain pending consumption counters for the next
 * learning envelope. Returns a compact per-id map. After the envelope
 * POSTs and gets acked, call resetConsumptionCounters() to clear.
 */
export function drainConsumptionFeedback(
  db: ISqliteDriver
): Array<{ id: string; trajectoryHash: string; usedCount: number; successCount: number; sourceTag: string | null }> {
  try {
    const rows = db
      .prepare(
        `SELECT id, trajectory_hash, consumption_count, consumption_success_count, source_tag
         FROM reasoning_bank
         WHERE consumption_count > 0`
      )
      .all() as Array<{
      id: string;
      trajectory_hash: string;
      consumption_count: number;
      consumption_success_count: number;
      source_tag: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      trajectoryHash: r.trajectory_hash,
      usedCount: r.consumption_count,
      successCount: r.consumption_success_count,
      sourceTag: r.source_tag,
    }));
  } catch {
    return [];
  }
}

export function resetConsumptionCounters(db: ISqliteDriver, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const chunk = 500;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const placeholders = slice.map(() => '?').join(',');
      db.prepare(
        `UPDATE reasoning_bank SET consumption_count = 0, consumption_success_count = 0 WHERE id IN (${placeholders})`
      ).run(...slice);
    }
  } catch {
    /* non-critical — next drain will retry the same rows */
  }
}

/**
 * JUDGE: Score how relevant a retrieved trajectory is for the current task.
 * Returns 0-1 relevance score.
 */
export function judgeRelevance(trajectory: Trajectory, currentTask: string): number {
  const taskWords = new Set(
    currentTask
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  const trajectoryWords = new Set(
    trajectory.taskDescription
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );

  // Jaccard similarity
  const intersection = [...taskWords].filter((w) => trajectoryWords.has(w)).length;
  const union = new Set([...taskWords, ...trajectoryWords]).size;

  if (union === 0) return 0;
  const similarity = intersection / union;

  // Boost by usage count (more used = more proven)
  const usageBoost = Math.min(0.2, trajectory.usageCount * 0.02);

  return Math.min(1, similarity + usageBoost);
}

/**
 * DISTILL: Extract the key pattern from a trajectory for reuse.
 * Returns a concise description of the approach.
 */
export function distillTrajectory(trajectory: Trajectory): string {
  const steps = trajectory.steps;
  const toolSequence = steps.map((s) => s.toolName).join(' → ');
  return `Previously successful approach (used ${String(trajectory.usageCount)} times, score: ${String(trajectory.successScore)}):\nTool sequence: ${toolSequence}\nOriginal task: ${trajectory.taskDescription}`;
}

/** Get statistics about the reasoning bank. */
export function getStats(db: ISqliteDriver): { totalTrajectories: number; totalUsages: number; avgScore: number } {
  const row = db
    .prepare(
      'SELECT COUNT(*) as total, COALESCE(SUM(usage_count), 0) as usages, COALESCE(AVG(success_score), 0) as avg_score FROM reasoning_bank'
    )
    .get() as Record<string, number>;
  return {
    totalTrajectories: row.total ?? 0,
    totalUsages: row.usages ?? 0,
    avgScore: Math.round((row.avg_score ?? 0) * 100) / 100,
  };
}

function rowToTrajectory(row: Record<string, unknown>): Trajectory {
  return {
    id: row.id as string,
    trajectoryHash: row.trajectory_hash as string,
    taskDescription: row.task_description as string,
    steps: JSON.parse((row.trajectory as string) || '[]'),
    successScore: (row.success_score as number) ?? 0,
    usageCount: (row.usage_count as number) ?? 0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
