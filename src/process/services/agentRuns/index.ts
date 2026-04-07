/**
 * @license Apache-2.0
 * Agent run tracking service for TitanX.
 * Records agent execution history, token usage, and run status.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

type AgentRun = {
  id: string;
  userId: string;
  conversationId: string;
  agentType: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  exitCode: number | null;
  error: string | null;
};

type AgentRunStats = {
  totalRuns: number;
  successfulRuns: number;
  errorRuns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostCents: number;
  avgDurationMs: number;
};

/**
 * Start tracking a new agent run.
 */
export function startRun(
  db: ISqliteDriver,
  input: { userId: string; conversationId: string; agentType: string }
): AgentRun {
  const id = crypto.randomUUID();
  const startedAt = Date.now();

  db.prepare(
    `INSERT INTO agent_runs (id, user_id, conversation_id, agent_type, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`
  ).run(id, input.userId, input.conversationId, input.agentType, startedAt);

  return {
    id,
    userId: input.userId,
    conversationId: input.conversationId,
    agentType: input.agentType,
    status: 'running',
    startedAt,
    finishedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    exitCode: null,
    error: null,
  };
}

/**
 * Complete an agent run with final status and metrics.
 */
export function finishRun(
  db: ISqliteDriver,
  input: {
    runId: string;
    status: 'done' | 'error';
    inputTokens?: number;
    outputTokens?: number;
    costCents?: number;
    exitCode?: number;
    error?: string;
  }
): void {
  const finishedAt = Date.now();

  db.prepare(
    `UPDATE agent_runs
     SET status = ?, finished_at = ?, input_tokens = ?, output_tokens = ?, cost_cents = ?, exit_code = ?, error = ?
     WHERE id = ?`
  ).run(
    input.status,
    finishedAt,
    input.inputTokens ?? 0,
    input.outputTokens ?? 0,
    input.costCents ?? 0,
    input.exitCode ?? null,
    input.error ?? null,
    input.runId
  );
}

/**
 * List agent runs with optional filters.
 */
export function listRuns(
  db: ISqliteDriver,
  params: {
    userId: string;
    conversationId?: string;
    agentType?: string;
    limit?: number;
  }
): AgentRun[] {
  const conditions: string[] = ['user_id = ?'];
  const args: unknown[] = [params.userId];

  if (params.conversationId) {
    conditions.push('conversation_id = ?');
    args.push(params.conversationId);
  }
  if (params.agentType) {
    conditions.push('agent_type = ?');
    args.push(params.agentType);
  }

  const limit = params.limit ?? 50;
  const rows = db
    .prepare(`SELECT * FROM agent_runs WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT ?`)
    .all(...args, limit) as Array<Record<string, unknown>>;

  return rows.map(rowToRun);
}

/**
 * Get aggregate run statistics for a user.
 */
export function getRunStats(db: ISqliteDriver, userId: string, fromDate?: number): AgentRunStats {
  const from = fromDate ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const row = db
    .prepare(
      `SELECT
       COUNT(*) as total_runs,
       CAST(COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS INTEGER) as successful_runs,
       CAST(COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS INTEGER) as error_runs,
       CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) as total_input_tokens,
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output_tokens,
       CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total_cost_cents,
       CAST(COALESCE(AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at END), 0) AS INTEGER) as avg_duration_ms
     FROM agent_runs WHERE user_id = ? AND started_at >= ?`
    )
    .get(userId, from) as Record<string, number>;

  return {
    totalRuns: row.total_runs,
    successfulRuns: row.successful_runs,
    errorRuns: row.error_runs,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCostCents: row.total_cost_cents,
    avgDurationMs: row.avg_duration_ms,
  };
}

function rowToRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    conversationId: row.conversation_id as string,
    agentType: row.agent_type as string,
    status: row.status as 'running' | 'done' | 'error',
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number) ?? null,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    costCents: (row.cost_cents as number) ?? 0,
    exitCode: (row.exit_code as number) ?? null,
    error: (row.error as string) ?? null,
  };
}
