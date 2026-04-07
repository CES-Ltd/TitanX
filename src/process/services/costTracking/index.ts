/**
 * @license Apache-2.0
 * Cost tracking service for TitanX.
 * Records and aggregates LLM token usage and costs.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

type CostEvent = {
  id: string;
  userId: string;
  conversationId?: string;
  agentType?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: number;
  billingType: string;
  occurredAt: number;
};

type CostEventInput = Omit<CostEvent, 'id'>;

type CostSummary = {
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

type AgentCostBreakdown = {
  agentType: string;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

type ProviderCostBreakdown = {
  provider: string;
  model: string;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
};

type WindowSpend = {
  windowLabel: string;
  windowMs: number;
  totalCostCents: number;
};

/**
 * Record a cost event.
 */
export function recordCost(db: ISqliteDriver, input: CostEventInput): CostEvent {
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO cost_events (id, user_id, conversation_id, agent_type, provider, model, input_tokens, output_tokens, cached_input_tokens, cost_cents, billing_type, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.userId, input.conversationId ?? null, input.agentType ?? null, input.provider, input.model, input.inputTokens, input.outputTokens, input.cachedInputTokens, input.costCents, input.billingType, input.occurredAt);

  return { ...input, id };
}

/**
 * Get aggregated cost summary.
 */
export function getCostSummary(db: ISqliteDriver, userId: string, fromDate?: number): CostSummary {
  const from = fromDate ?? getMonthStart();
  const row = db.prepare(
    `SELECT
       CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total_cost_cents,
       CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) as total_input_tokens,
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output_tokens,
       COUNT(*) as event_count
     FROM cost_events WHERE user_id = ? AND occurred_at >= ?`
  ).get(userId, from) as Record<string, number>;

  return {
    totalCostCents: row.total_cost_cents,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    eventCount: row.event_count,
  };
}

/**
 * Get cost breakdown by agent type.
 */
export function getCostByAgent(db: ISqliteDriver, userId: string, fromDate?: number): AgentCostBreakdown[] {
  const from = fromDate ?? getMonthStart();
  const rows = db.prepare(
    `SELECT
       agent_type,
       CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total_cost_cents,
       CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) as total_input_tokens,
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output_tokens,
       COUNT(*) as event_count
     FROM cost_events WHERE user_id = ? AND occurred_at >= ? AND agent_type IS NOT NULL
     GROUP BY agent_type ORDER BY total_cost_cents DESC`
  ).all(userId, from) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    agentType: r.agent_type as string,
    totalCostCents: r.total_cost_cents as number,
    totalInputTokens: r.total_input_tokens as number,
    totalOutputTokens: r.total_output_tokens as number,
    eventCount: r.event_count as number,
  }));
}

/**
 * Get cost breakdown by provider and model.
 */
export function getCostByProvider(db: ISqliteDriver, userId: string, fromDate?: number): ProviderCostBreakdown[] {
  const from = fromDate ?? getMonthStart();
  const rows = db.prepare(
    `SELECT
       provider, model,
       CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total_cost_cents,
       CAST(COALESCE(SUM(input_tokens), 0) AS INTEGER) as total_input_tokens,
       CAST(COALESCE(SUM(output_tokens), 0) AS INTEGER) as total_output_tokens,
       COUNT(*) as event_count
     FROM cost_events WHERE user_id = ? AND occurred_at >= ?
     GROUP BY provider, model ORDER BY total_cost_cents DESC`
  ).all(userId, from) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    provider: r.provider as string,
    model: r.model as string,
    totalCostCents: r.total_cost_cents as number,
    totalInputTokens: r.total_input_tokens as number,
    totalOutputTokens: r.total_output_tokens as number,
    eventCount: r.event_count as number,
  }));
}

/**
 * Get spend for rolling time windows (5h, 24h, 7d).
 */
export function getWindowSpend(db: ISqliteDriver, userId: string): WindowSpend[] {
  const now = Date.now();
  const windows = [
    { label: '5h', ms: 5 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  ];

  return windows.map(({ label, ms }) => {
    const from = now - ms;
    const row = db.prepare(
      `SELECT CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total
       FROM cost_events WHERE user_id = ? AND occurred_at >= ?`
    ).get(userId, from) as { total: number };

    return { windowLabel: label, windowMs: ms, totalCostCents: row.total };
  });
}

function getMonthStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}
