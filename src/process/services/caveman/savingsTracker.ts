/**
 * Caveman Mode savings tracker — records and aggregates token savings.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { CavemanMode } from './index';

export type CavemanSavingsInput = {
  userId: string;
  conversationId?: string;
  mode: Exclude<CavemanMode, 'off'>;
  inputTokens: number;
  outputTokens: number;
  estimatedRegularOutput: number;
  tokensSaved: number;
  occurredAt: number;
};

export type CavemanSummary = {
  totalOutputTokens: number;
  totalEstimatedRegular: number;
  totalTokensSaved: number;
  savingsPercent: number;
  eventCount: number;
};

export type CavemanModeBreakdown = {
  mode: string;
  totalOutputTokens: number;
  totalEstimatedRegular: number;
  totalTokensSaved: number;
  savingsPercent: number;
  eventCount: number;
};

function getMonthStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function recordSavings(db: ISqliteDriver, input: CavemanSavingsInput): void {
  const id = crypto.randomUUID();
  console.log(
    `[Caveman-Savings] INSERT: mode=${input.mode} output=${String(input.outputTokens)} estimated_regular=${String(input.estimatedRegularOutput)} saved=${String(input.tokensSaved)}`
  );
  db.prepare(
    `INSERT INTO caveman_savings (id, user_id, conversation_id, mode, input_tokens, output_tokens, estimated_regular_output, tokens_saved, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.conversationId ?? null,
    input.mode,
    input.inputTokens,
    input.outputTokens,
    input.estimatedRegularOutput,
    input.tokensSaved,
    input.occurredAt
  );
}

export function getSummary(db: ISqliteDriver, userId: string, fromDate?: number): CavemanSummary {
  const from = fromDate ?? getMonthStart();
  const row = db
    .prepare(
      `SELECT
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output,
       CAST(COALESCE(SUM(estimated_regular_output), 0) AS INTEGER) as total_estimated,
       CAST(COALESCE(SUM(tokens_saved), 0) AS INTEGER) as total_saved,
       COUNT(*) as event_count
     FROM caveman_savings WHERE user_id = ? AND occurred_at >= ?`
    )
    .get(userId, from) as Record<string, number>;

  const totalEstimated = row.total_estimated ?? 0;
  return {
    totalOutputTokens: row.total_output ?? 0,
    totalEstimatedRegular: totalEstimated,
    totalTokensSaved: row.total_saved ?? 0,
    savingsPercent: totalEstimated > 0 ? Math.round(((row.total_saved ?? 0) / totalEstimated) * 100) : 0,
    eventCount: row.event_count ?? 0,
  };
}

export function getByMode(db: ISqliteDriver, userId: string, fromDate?: number): CavemanModeBreakdown[] {
  const from = fromDate ?? getMonthStart();
  const rows = db
    .prepare(
      `SELECT mode,
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output,
       CAST(COALESCE(SUM(estimated_regular_output), 0) AS INTEGER) as total_estimated,
       CAST(COALESCE(SUM(tokens_saved), 0) AS INTEGER) as total_saved,
       COUNT(*) as event_count
     FROM caveman_savings WHERE user_id = ? AND occurred_at >= ?
     GROUP BY mode ORDER BY mode`
    )
    .all(userId, from) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const totalEstimated = (r.total_estimated as number) ?? 0;
    return {
      mode: r.mode as string,
      totalOutputTokens: (r.total_output as number) ?? 0,
      totalEstimatedRegular: totalEstimated,
      totalTokensSaved: (r.total_saved as number) ?? 0,
      savingsPercent: totalEstimated > 0 ? Math.round((((r.total_saved as number) ?? 0) / totalEstimated) * 100) : 0,
      eventCount: (r.event_count as number) ?? 0,
    };
  });
}
