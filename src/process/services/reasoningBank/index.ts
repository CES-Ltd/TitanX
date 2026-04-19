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
  db.prepare(
    `INSERT INTO reasoning_bank (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, hash, input.taskDescription, JSON.stringify(input.steps), input.successScore, Date.now(), Date.now());

  console.log(
    `[ReasoningBank] Stored new trajectory ${id} (${String(input.steps.length)} steps, score: ${String(input.successScore)})`
  );
  return id;
}

/**
 * RETRIEVE: Find similar trajectories for a given task description.
 * Uses simple keyword matching (future: semantic search with HNSW).
 */
export function findSimilarTrajectories(db: ISqliteDriver, taskDescription: string, limit: number = 3): Trajectory[] {
  // Simple keyword matching — extract key terms and search
  const keywords = taskDescription
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  // Build LIKE clauses for each keyword
  const conditions = keywords.map(() => 'task_description LIKE ?').join(' OR ');
  const params = keywords.map((k) => `%${k}%`);

  // v2.5.0 Phase A3 — explicit fleet-consolidated preference. Fleet-
  // wisdom (source_tag='fleet_consolidated', aggregated across many
  // devices) should beat a locally-repeated pattern of similar match
  // quality. The pre-v2.5 ordering was `usage_count DESC, success_score
  // DESC` and relied on the consolidated row's usage_count being a
  // sum-of-all-devices (and therefore usually larger than local). But
  // a slave that repeats one local pattern 50 times could outrank a
  // fleet pattern seen 10 times on 5 devices — exactly the opposite of
  // what we want. Sort by source_tag first, then the existing keys.
  const rows = db
    .prepare(
      `SELECT * FROM reasoning_bank
       WHERE (${conditions}) AND success_score >= 0.7
       ORDER BY (source_tag = 'fleet_consolidated') DESC, usage_count DESC, success_score DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToTrajectory);
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
