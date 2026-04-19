/**
 * @license Apache-2.0
 * TurnFinalizer — post-turn observability + learning side effects.
 *
 * Extracted from TeammateManager.finalizeTurn (Phase 3.2) to isolate the
 * "record what happened" cluster from the orchestration-critical path.
 * Every method here:
 *   - runs after all actions have already executed
 *   - is non-blocking: failures are logged but never propagated
 *   - writes to stores (ReasoningBank, cost, audit, agent memory, plans,
 *     traces) or emits telemetry
 *
 * Callers should fire observeTurn() from the tail of their turn-completion
 * path. TurnFinalizer never mutates agent state, never sends mailbox
 * messages, never wakes agents — those are orchestration concerns that
 * stay with TeammateManager.
 */

import type { TeamAgent, ParsedAction } from './types';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import { getDatabase } from '@process/services/database';
import * as costTrackingService from '@process/services/costTracking';
import * as activityLogService from '@process/services/activityLog';
import * as agentMemoryService from '@process/services/agentMemory';
import * as reasoningBank from '@process/services/reasoningBank';
import * as agentPlanningService from '@process/services/agentPlanning';
import * as tracingService from '@process/services/tracing';
import * as securityFeaturesService from '@process/services/securityFeatures';
import { logNonCritical } from '@process/utils/logNonCritical';
import { costProviderFor, resolveConversationType } from './conversationTypes';

/**
 * Outcome of an agent turn, as seen by the finalizer.
 * Contains everything needed to record observability data without requiring
 * the caller to pass a full TeammateManager reference.
 */
export type TurnOutcome = {
  teamId: string;
  agent: TeamAgent;
  conversationId: string;
  accumulatedText: string;
  /** All actions parsed from the turn (passed + blocked by policy/hooks). */
  actions: readonly ParsedAction[];
  /** Snapshot of the team at finalize time — for queen-drift context. */
  agents: readonly TeamAgent[];
};

/** Queen-drift detection knobs. Exposed for tests; production defaults are fine. */
export type QueenDriftConfig = {
  /** Minimum output length before drift detection runs. */
  minTextLength: number;
  /** Drift score below which a correction event is logged (0 = complete drift). */
  driftThreshold: number;
  /** Minimum number of meaningful goal words before scoring is meaningful. */
  minGoalWords: number;
};

const DEFAULT_DRIFT_CONFIG: QueenDriftConfig = {
  minTextLength: 50,
  driftThreshold: 0.2,
  minGoalWords: 2,
};

export class TurnFinalizer {
  constructor(private readonly driftConfig: QueenDriftConfig = DEFAULT_DRIFT_CONFIG) {}

  /**
   * Run the full observability pass for a completed turn. Safe to await from
   * the orchestration path: all internal failures are caught and logged.
   */
  async observeTurn(outcome: TurnOutcome): Promise<void> {
    let driver: ISqliteDriver;
    try {
      const db = await getDatabase();
      driver = db.getDriver();
    } catch (e) {
      logNonCritical('team.turn-finalizer.db', e);
      return;
    }

    // Each observer runs independently — one failure never blocks the others.
    await this.recordReasoningBank(driver, outcome);
    this.detectQueenDrift(driver, outcome);
    this.recordCostAndAudit(driver, outcome);
    this.storeAgentMemory(driver, outcome);
    this.autoCreatePlan(driver, outcome);
    this.recordTrace(driver, outcome);
  }

  // ── ReasoningBank: store the trajectory for future replay ──────────────

  private async recordReasoningBank(driver: ISqliteDriver, outcome: TurnOutcome): Promise<void> {
    // Only the non-message actions form a learnable trajectory.
    const serialActions = outcome.actions.filter((a) => a.type !== 'send_message');
    if (serialActions.length === 0) return;
    try {
      // v2.5.0 Phase B2 — capture failures too. Pre-v2.5 only stored
      // turns with successScore >= 0.7 (implicitly, by only writing
      // the completed/active branch with 0.8). Failures were
      // discarded — throwing away half the learning signal. Now we
      // stamp `failure_pattern = 1` on non-success turns so Phase
      // C's distillation prompt can extract avoidance rules
      // ("don't do X, it fails on Y") alongside winning paths.
      const isSuccess = outcome.agent.status === 'completed' || outcome.agent.status === 'active';

      // v2.5.0 final — workspace scope. Look up the team row for
      // `outcome.teamId` once and stamp the workspace on the
      // trajectory. Keeps cross-tenant retrieval walls intact.
      // Best-effort: if the row is missing or malformed, we fall
      // back to a fleet-wide (null-workspace) trajectory.
      let workspaceId: string | undefined;
      try {
        const row = driver.prepare('SELECT workspace FROM teams WHERE id = ?').get(outcome.teamId) as
          | { workspace: string | null }
          | undefined;
        if (row?.workspace && row.workspace.trim().length > 0) workspaceId = row.workspace;
      } catch {
        /* table may not exist in tests; leave workspaceId undefined */
      }

      // v2.5.0 final — richer trajectory capture. Instead of stamping
      // the same truncated accumulatedText as the result on every
      // step, include the full (truncated) agent reasoning once at the
      // trajectory level via the first step's result, then leave the
      // remaining steps with a short action-specific marker. This
      // gives the master's distillation prompt enough context to
      // understand WHY the tool sequence worked, without blowing up
      // the trajectory payload beyond Phase D's 500KB budget.
      const reasoningSnippet = outcome.accumulatedText.slice(0, 1000);
      const steps = serialActions.map((a, i) => ({
        toolName: a.type,
        args: { ...(a as Record<string, unknown>) },
        result: i === 0 ? reasoningSnippet : `step ${String(i + 1)} of ${String(serialActions.length)}`,
        durationMs: 0,
      }));

      const trajectoryId = reasoningBank.storeTrajectory(driver, {
        taskDescription: `${outcome.agent.agentName}: ${outcome.accumulatedText.slice(0, 100)}`,
        steps,
        successScore: isSuccess ? 0.8 : 0.3,
        failurePattern: !isSuccess,
        workspaceId,
      });
      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'agent',
        actorId: outcome.agent.agentName,
        action: isSuccess ? 'reasoning_bank.trajectory_stored' : 'reasoning_bank.failure_stored',
        entityType: 'reasoning_bank',
        entityId: trajectoryId,
        details: {
          steps: serialActions.length,
          agent: outcome.agent.agentName,
          failurePattern: !isSuccess,
        },
      });
    } catch (e) {
      logNonCritical('team.turn-finalizer.reasoning-bank', e);
    }
  }

  // ── Queen-mode drift detection ─────────────────────────────────────────

  /**
   * If a queen agent exists, score how related the worker's output is to the
   * team's goal (approximated by the lead's name). Low overlap → log a drift
   * event so operators can see degradation over time. Pure computation + one
   * activity-log write; safe to swallow failures.
   */
  private detectQueenDrift(driver: ISqliteDriver, outcome: TurnOutcome): void {
    try {
      const queen = outcome.agents.find((a) => a.role === 'queen');
      if (!queen) return;
      if (outcome.agent.role !== 'teammate') return;
      if (outcome.accumulatedText.length <= this.driftConfig.minTextLength) return;

      const leadAgent = outcome.agents.find((a) => a.role === 'lead');
      const teamGoal = leadAgent?.agentName ?? queen.agentName ?? '';
      const goalWords = teamGoal
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 3);
      if (goalWords.length < this.driftConfig.minGoalWords) return;

      const outputWords = new Set(outcome.accumulatedText.toLowerCase().split(/\s+/));
      const overlap = goalWords.filter((w: string) => outputWords.has(w)).length;
      const driftScore = overlap / goalWords.length;

      if (driftScore >= this.driftConfig.driftThreshold) return;

      console.log(
        `[Queen] Drift detected in ${outcome.agent.agentName}: output has ${String(Math.round(driftScore * 100))}% goal overlap`
      );
      try {
        activityLogService.logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: queen.agentName,
          action: 'queen.drift_detected',
          entityType: 'team',
          entityId: outcome.agent.slotId,
          details: {
            worker: outcome.agent.agentName,
            driftScore: Math.round(driftScore * 100),
            goalWords: goalWords.length,
          },
        });
      } catch (e) {
        logNonCritical('team.turn-finalizer.queen-audit', e);
      }
    } catch (e) {
      logNonCritical('team.turn-finalizer.queen-detect', e);
    }
  }

  // ── Cost + audit recording ─────────────────────────────────────────────

  private recordCostAndAudit(driver: ISqliteDriver, outcome: TurnOutcome): void {
    try {
      const textLen = outcome.accumulatedText.length;
      const estimatedOutputTokens = Math.ceil(textLen / 4);

      // Map user-visible agentType → conversationType → cost provider,
      // keeping the switch logic centralized in conversationTypes.ts.
      const conversationType = resolveConversationType(outcome.agent.agentType);
      costTrackingService.recordCost(driver, {
        userId: 'system_default_user',
        conversationId: outcome.conversationId,
        agentType: outcome.agent.agentType,
        provider: costProviderFor(conversationType),
        model: outcome.agent.agentType,
        inputTokens: 0,
        outputTokens: estimatedOutputTokens,
        cachedInputTokens: 0,
        costCents: 0,
        billingType: 'metered_api',
        occurredAt: Date.now(),
      });

      activityLogService.logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'agent',
        actorId: outcome.agent.slotId,
        action: 'agent.turn_completed',
        entityType: 'conversation',
        entityId: outcome.conversationId,
        agentId: outcome.agent.slotId,
        details: {
          agentName: outcome.agent.agentName,
          agentType: outcome.agent.agentType,
          actionsExecuted: outcome.actions.length,
          outputTokensEstimate: estimatedOutputTokens,
        },
      });
    } catch (e) {
      logNonCritical('team.turn-finalizer.cost-audit', e);
    }
  }

  // ── Agent memory (buffer + prune) ──────────────────────────────────────

  private storeAgentMemory(driver: ISqliteDriver, outcome: TurnOutcome): void {
    if (outcome.accumulatedText.length === 0) return;
    try {
      if (!securityFeaturesService.isFeatureEnabled(driver, 'agent_memory')) return;
      const estimatedOutputTokens = Math.ceil(outcome.accumulatedText.length / 4);
      agentMemoryService.addToBuffer(
        driver,
        outcome.agent.slotId,
        outcome.teamId,
        {
          role: 'assistant',
          content: outcome.accumulatedText.slice(0, 2000),
          turnActions: outcome.actions.map((a) => a.type),
        },
        estimatedOutputTokens
      );
      agentMemoryService.pruneMemory(driver, outcome.agent.slotId, 8000);
    } catch (e) {
      logNonCritical('team.turn-finalizer.agent-memory', e);
    }
  }

  // ── Auto-plan creation when multiple tasks are created in one turn ─────

  private autoCreatePlan(driver: ISqliteDriver, outcome: TurnOutcome): void {
    try {
      if (!securityFeaturesService.isFeatureEnabled(driver, 'agent_planning')) return;
      const taskActions = outcome.actions.filter((a) => a.type === 'task_create');
      if (taskActions.length < 2) return;
      agentPlanningService.createPlan(
        driver,
        outcome.agent.slotId,
        outcome.teamId,
        `Auto-plan: ${outcome.agent.agentName} turn`,
        taskActions.map((a) => (a as { subject: string }).subject)
      );
    } catch (e) {
      logNonCritical('team.turn-finalizer.auto-plan', e);
    }
  }

  // ── Tracing ────────────────────────────────────────────────────────────

  private recordTrace(driver: ISqliteDriver, outcome: TurnOutcome): void {
    try {
      if (!securityFeaturesService.isFeatureEnabled(driver, 'trace_system')) return;
      const estimatedOutputTokens = Math.ceil(outcome.accumulatedText.length / 4);
      const handle = tracingService.startRun(driver, `turn:${outcome.agent.agentName}`, 'agent', {
        agentSlotId: outcome.agent.slotId,
        teamId: outcome.teamId,
      });
      handle.setTokens(0, estimatedOutputTokens, 0);
      handle.end({ actionsExecuted: outcome.actions.length, textLength: outcome.accumulatedText.length });
    } catch (e) {
      logNonCritical('team.turn-finalizer.trace', e);
    }
  }
}
