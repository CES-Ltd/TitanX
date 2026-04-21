/**
 * @license Apache-2.0
 * Agent Workflow Builder — workflow-family trajectory digest.
 *
 * v2.6.0 Phase 4.x. Every completed + failed agent-workflow run
 * lands a trajectory in `reasoning_bank` with task_description
 * prefixed `[workflow:<canonicalId>] <name>` (see
 * agentDispatcher.captureRunTrajectory). This module aggregates
 * those trajectories per canonical family so:
 *
 *   1. Operators can see a "how does my workflow actually perform?"
 *      view without having to hand-roll a SQL query.
 *   2. The nightly Dream Mode pass has a ready-to-use filter when
 *      it later adds an LLM distillation stage for workflow families
 *      ("suggest a tighter safe_commit@1 variant based on successful
 *      runs across the fleet").
 *
 * This commit ships the aggregation + a simple suggestion heuristic;
 * the LLM distillation prompt engineering is an explicit follow-up
 * that will call `summarizeWorkflowFamily` as its data source.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type TrajectoryStep = {
  toolName: string;
  args?: unknown;
  result?: unknown;
  durationMs?: number;
};

type ReasoningBankRow = {
  id: string;
  task_description: string;
  trajectory: string;
  success_score: number;
  usage_count: number;
  failure_pattern: number | null;
  created_at: number;
  updated_at: number;
};

export type WorkflowFamilyDigest = {
  canonicalId: string;
  /** Total trajectories observed for this canonical id. */
  trajectoryCount: number;
  /** Count that were successful (success_score >= 0.7 OR failure_pattern=0). */
  successCount: number;
  /** successCount / trajectoryCount, 0 when no trajectories. */
  successRate: number;
  /** Most recent timestamp across the family. 0 when empty. */
  lastSeenAt: number;
  /**
   * Most common step sequence among SUCCESSFUL trajectories — the
   * "canonical successful path". Sequences compared by their ordered
   * `toolName` arrays; the sequence appearing most often wins.
   * Ties broken by most-recent. Empty array when no successes.
   */
  mostCommonSuccessfulPath: string[];
  /**
   * Most common step sequence among FAILED trajectories. Useful as
   * an avoidance-rule signal alongside the successful path.
   */
  mostCommonFailurePath: string[];
  /**
   * Heuristic suggestion for operators. Non-LLM; produced from the
   * aggregation above. Intended to answer "is my workflow actually
   * shaped like what succeeds in practice?". Empty string when the
   * sample is too small to reason about (< MIN_SAMPLE_SIZE).
   */
  suggestion: string;
};

const MIN_SAMPLE_SIZE = 5;

/**
 * Parse a trajectory JSON blob. reasoning_bank.trajectory is a JSON
 * string — either `TrajectoryStep[]` (the expected shape) or legacy
 * shapes that we defensively ignore.
 */
function parseTrajectory(raw: string): TrajectoryStep[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is TrajectoryStep =>
        typeof s === 'object' && s !== null && typeof (s as { toolName?: unknown }).toolName === 'string'
    );
  } catch {
    return [];
  }
}

/**
 * Group trajectories by their ordered toolName sequence and return
 * the sequence with the highest count. Stable under ties (the first
 * sequence seen wins when counts tie — deterministic over identical
 * input order).
 */
function pickMostCommonSequence(trajectories: TrajectoryStep[][]): string[] {
  if (trajectories.length === 0) return [];
  const seqCounts = new Map<string, { path: string[]; count: number }>();
  for (const t of trajectories) {
    const path = t.map((s) => s.toolName);
    const key = path.join('|');
    const existing = seqCounts.get(key);
    if (existing) existing.count += 1;
    else seqCounts.set(key, { path, count: 1 });
  }
  let best: { path: string[]; count: number } | undefined;
  for (const v of seqCounts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best?.path ?? [];
}

/**
 * Summarize all trajectories captured from runs of `canonicalId`
 * (e.g. `builtin:workflow.safe_commit@1`). Queries `reasoning_bank`
 * directly so callers don't need to know the row shape.
 */
export function summarizeWorkflowFamily(db: ISqliteDriver, canonicalId: string): WorkflowFamilyDigest {
  const prefix = `[workflow:${canonicalId}] %`;
  let rows: ReasoningBankRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, task_description, trajectory, success_score, usage_count, failure_pattern,
                created_at, updated_at
         FROM reasoning_bank
         WHERE task_description LIKE ?`
      )
      .all(prefix) as ReasoningBankRow[];
  } catch {
    // reasoning_bank may be missing on a partial install; treat as empty.
    return emptyDigest(canonicalId);
  }

  if (rows.length === 0) return emptyDigest(canonicalId);

  const successful: TrajectoryStep[][] = [];
  const failed: TrajectoryStep[][] = [];
  let lastSeenAt = 0;

  for (const r of rows) {
    const isSuccess = r.failure_pattern === 0 && r.success_score >= 0.7;
    const steps = parseTrajectory(r.trajectory);
    if (steps.length === 0) continue;
    if (isSuccess) successful.push(steps);
    else failed.push(steps);
    if (r.updated_at > lastSeenAt) lastSeenAt = r.updated_at;
  }

  const mostCommonSuccessfulPath = pickMostCommonSequence(successful);
  const mostCommonFailurePath = pickMostCommonSequence(failed);
  const trajectoryCount = successful.length + failed.length;
  const successCount = successful.length;
  const successRate = trajectoryCount === 0 ? 0 : successCount / trajectoryCount;

  const suggestion = buildSuggestion({
    trajectoryCount,
    successRate,
    mostCommonSuccessfulPath,
    mostCommonFailurePath,
  });

  return {
    canonicalId,
    trajectoryCount,
    successCount,
    successRate: Math.round(successRate * 100) / 100,
    lastSeenAt,
    mostCommonSuccessfulPath,
    mostCommonFailurePath,
    suggestion,
  };
}

function emptyDigest(canonicalId: string): WorkflowFamilyDigest {
  return {
    canonicalId,
    trajectoryCount: 0,
    successCount: 0,
    successRate: 0,
    lastSeenAt: 0,
    mostCommonSuccessfulPath: [],
    mostCommonFailurePath: [],
    suggestion: '',
  };
}

/**
 * Non-LLM heuristic suggestion. Three branches:
 *
 *   1. Sample too small → empty string ("not enough signal").
 *   2. successRate >= 0.8 → confirm the pattern works ("this is the
 *      happy path — keep the safety nets").
 *   3. Low success rate + common failure path → flag the divergence
 *      ("your failing runs consistently differ from your successful
 *      ones at step N; consider restructuring").
 *
 * The LLM distillation follow-up will replace this with a prompt
 * that reads the full step args + results, not just the tool-name
 * sequence. For v2.6.0 the heuristic gives operators a meaningful
 * first read without waiting on the prompt work.
 */
function buildSuggestion(input: {
  trajectoryCount: number;
  successRate: number;
  mostCommonSuccessfulPath: string[];
  mostCommonFailurePath: string[];
}): string {
  if (input.trajectoryCount < MIN_SAMPLE_SIZE) return '';
  if (input.successRate >= 0.8) {
    return `Strong signal: ${Math.round(input.successRate * 100)}% of ${String(input.trajectoryCount)} runs succeed. The common successful path (${input.mostCommonSuccessfulPath.join(' → ')}) is working — consider locking it in.`;
  }
  if (input.mostCommonSuccessfulPath.length > 0 && input.mostCommonFailurePath.length > 0) {
    // Find the first divergence.
    const min = Math.min(input.mostCommonSuccessfulPath.length, input.mostCommonFailurePath.length);
    let divergeAt = min;
    for (let i = 0; i < min; i++) {
      if (input.mostCommonSuccessfulPath[i] !== input.mostCommonFailurePath[i]) {
        divergeAt = i;
        break;
      }
    }
    return `Success rate ${Math.round(input.successRate * 100)}% across ${String(input.trajectoryCount)} runs. Successful vs failing paths diverge at step ${String(divergeAt + 1)} — successful runs do ${input.mostCommonSuccessfulPath[divergeAt] ?? 'finish'}, failing runs do ${input.mostCommonFailurePath[divergeAt] ?? 'stop'}.`;
  }
  return `Success rate ${Math.round(input.successRate * 100)}% across ${String(input.trajectoryCount)} runs. Not enough structure in the step sequences to surface a specific suggestion yet.`;
}
