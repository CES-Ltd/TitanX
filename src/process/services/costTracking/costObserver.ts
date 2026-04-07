/**
 * @license Apache-2.0
 * Cost observer for TitanX.
 * Provides a lightweight mechanism to capture token usage from agent responses
 * and record cost events without modifying existing agent adapters.
 *
 * Usage:
 *   import { CostObserver } from '@process/services/costTracking/costObserver';
 *
 *   // At conversation start
 *   const observer = new CostObserver(userId, conversationId, agentType);
 *
 *   // When token usage becomes available (from agent response metadata)
 *   observer.recordUsage({ provider, model, inputTokens, outputTokens, costCents });
 *
 *   // At conversation end
 *   observer.flush();
 */

import { getDatabase } from '@process/services/database';
import * as costTrackingService from '@process/services/costTracking';
import * as agentRunsService from '@process/services/agentRuns';
import * as budgetService from '@process/services/budgets';

type UsageData = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costCents?: number;
};

/**
 * Observes and records cost data for a single conversation turn.
 * Create one per conversation message send, then call recordUsage
 * when the agent reports token counts.
 */
export class CostObserver {
  private userId: string;
  private conversationId: string;
  private agentType: string;
  private runId: string | null = null;
  private recorded = false;

  constructor(userId: string, conversationId: string, agentType: string) {
    this.userId = userId;
    this.conversationId = conversationId;
    this.agentType = agentType;
  }

  /**
   * Start tracking an agent run. Call at the beginning of agent execution.
   */
  async startRun(): Promise<string> {
    const db = await getDatabase();
    const run = agentRunsService.startRun(db.getDriver(), {
      userId: this.userId,
      conversationId: this.conversationId,
      agentType: this.agentType,
    });
    this.runId = run.id;
    return run.id;
  }

  /**
   * Record token usage and cost. Safe to call multiple times — only the first call records.
   */
  async recordUsage(usage: UsageData): Promise<void> {
    if (this.recorded) return;
    this.recorded = true;

    const db = await getDatabase();
    const driver = db.getDriver();

    costTrackingService.recordCost(driver, {
      userId: this.userId,
      conversationId: this.conversationId,
      agentType: this.agentType,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      costCents: usage.costCents ?? 0,
      billingType: 'metered_api',
      occurredAt: Date.now(),
    });

    // Check and enforce budgets
    budgetService.enforceBudgets(driver, this.userId);
  }

  /**
   * Complete the agent run. Call when the turn finishes.
   */
  async finishRun(status: 'done' | 'error', error?: string): Promise<void> {
    if (!this.runId) return;

    const db = await getDatabase();
    agentRunsService.finishRun(db.getDriver(), {
      runId: this.runId,
      status,
      error,
    });
  }
}

/**
 * Check if an agent type is blocked by budget enforcement.
 * Call before starting an agent execution to prevent overspend.
 */
export async function isBudgetBlocked(
  userId: string,
  agentType: string
): Promise<{ blocked: boolean; reason?: string }> {
  const db = await getDatabase();
  return budgetService.checkBudget(db.getDriver(), userId, 'agent_type', agentType);
}
