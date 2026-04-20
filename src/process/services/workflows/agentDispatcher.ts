/**
 * @license Apache-2.0
 * Agent Workflow Builder — per-turn dispatcher.
 *
 * Orchestrates agent-workflow execution across many agent turns.
 * Unlike the one-shot `executeWorkflow()` (engine.ts) which processes
 * a full DAG top-to-bottom in a single call, this dispatcher runs
 * one turn's worth of steps at a time:
 *
 *   - Non-deferred steps (tool.git.*, sprint.*, condition, loop) run
 *     immediately in-dispatcher; their output is persisted and the
 *     state machine advances to the next active step.
 *   - Deferred steps (prompt.*) return a `__deferred: true` envelope;
 *     the dispatcher stops the walk, stashes a `__pendingStep` in
 *     `state_json`, and returns an injection block for the next LLM
 *     turn. The LLM output from that turn is captured by
 *     `observeTurnCompletion` (called from TurnFinalizer) which
 *     advances the state machine.
 *
 * State machine transitions happen inside the busy guard so a
 * mid-flight dispatch can never race a second dispatch for the same
 * slot. All persistence goes through `agentRunState` helpers; the
 * dispatcher never touches `agent_workflow_runs` directly.
 *
 * Event emission — a Node EventEmitter surfaces lifecycle events
 * (run-started, step-completed, run-completed, run-failed). The IPC
 * bridge in a later commit subscribes to this emitter and
 * re-publishes as `agent-workflows.on*` renderer events.
 *
 * Security — two independent gates apply:
 *   1. `agent_workflows` security feature toggle — master kill
 *      switch. When off, prepareTurnContext returns null and the
 *      agent runs free (backward-compat with pre-v2.6.0).
 *   2. IAM check (`isToolAllowed`) — per-node for tool.git.* and
 *      sprint.* types. Denial raises WorkflowStepError with code
 *      IAM_DENIED; routing depends on the node's onError policy.
 */

import { EventEmitter } from 'events';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { WorkflowConnection, WorkflowDefinition, WorkflowNode } from './types';
import {
  createRun,
  getActiveRun,
  updateRunSteps,
  updateRunState,
  updateRunStatus,
  appendTrace,
  abortRun as abortRunInState,
} from './agentRunState';
import { resolveActiveBinding } from './agentBinding';
import { agentWorkflowBusyGuard } from './AgentWorkflowBusyGuard';
import type { AgentWorkflowRun } from './agent-types';
import { WorkflowStepError } from './agent-types';
import {
  AGENT_CONTEXT_KEY,
  type HandlerAgentContext,
  type PromptDeferredOutput,
} from './handlers/agent/promptHandlers';
import { getRegisteredHandler, type NodeHandler } from './engine';
import { isToolAllowed } from '../agentSandbox';
import { isFeatureEnabled } from '../securityFeatures';
import { logNonCritical } from '@process/utils/logNonCritical';

/**
 * Event bus for dispatcher lifecycle events. The IPC bridge
 * (agentWorkflowBridge, added in a later commit) subscribes to this
 * and re-publishes as renderer events. Kept as a module-level
 * singleton so there's a single source of truth for subscription.
 */
export const dispatcherEvents = new EventEmitter();

/** Tuning: bounded loop walk to avoid dispatcher pathologies (e.g. cycles). */
const MAX_STEPS_PER_TURN = 32;

/** Required tool-id per node type for the IAM gate. Null = no gate. */
function getRequiredToolForNode(node: WorkflowNode): string | null {
  if (node.type.startsWith('tool.git.')) return 'mcp.shell.exec';
  if (node.type === 'sprint.create_task') return 'team_task_create';
  if (node.type === 'sprint.update_task') return 'team_task_update';
  if (node.type === 'sprint.list_tasks') return 'team_task_list';
  return null;
}

export type PrepareTurnParams = {
  db: ISqliteDriver;
  slotId: string;
  teamId?: string;
  conversationId?: string;
  agentGalleryId?: string;
  /** Agent's IAM allowlist. Empty = all tools allowed (agentSandbox semantics). */
  allowedTools: string[];
  /** Turn number for trace correlation. */
  turnNumber: number;
};

export type TurnInjection = {
  /** Rendered block to append to presetContext. */
  injectedContext: string;
  runId: string;
  /** The deferred step whose output will be captured post-turn. */
  stepId: string;
};

/**
 * Called by AcpAgentManager before sending a turn. Resolves the
 * active binding, starts or resumes a run, dispatches non-deferred
 * steps until a deferred step is reached or the run completes, and
 * returns the injection block for the next LLM turn.
 *
 * Returns null when:
 *   - `agent_workflows` security feature is disabled
 *   - the slot has no binding and no active run
 *   - dispatch completed a pure tool chain this turn with no
 *     deferred step remaining
 *   - another dispatch is already in flight (busy guard)
 */
export async function prepareTurnContext(params: PrepareTurnParams): Promise<TurnInjection | null> {
  const { db, slotId, allowedTools, turnNumber } = params;

  if (!isFeatureEnabled(db, 'agent_workflows')) return null;
  if (agentWorkflowBusyGuard.isDispatching(slotId)) return null;

  let run = getActiveRun(db, slotId);
  if (!run) {
    const binding = resolveActiveBinding(db, { slotId, agentGalleryId: params.agentGalleryId });
    if (!binding) return null;
    const workflow = loadWorkflowDefinition(db, binding.workflowDefinitionId);
    if (!workflow) return null;
    run = createRun(db, {
      workflow,
      agentSlotId: slotId,
      teamId: params.teamId,
      conversationId: params.conversationId,
    });
    dispatcherEvents.emit('run-started', run);
  }

  if (run.status === 'paused') return null;

  agentWorkflowBusyGuard.setDispatching(slotId, true);

  try {
    return await walkActiveSteps({
      db,
      run,
      slotId,
      teamId: params.teamId,
      conversationId: params.conversationId,
      agentGalleryId: params.agentGalleryId,
      allowedTools,
      turnNumber,
    });
  } catch (err) {
    logNonCritical('agent-workflow.dispatch', err);
    return null;
  } finally {
    agentWorkflowBusyGuard.setDispatching(slotId, false);
  }
}

/**
 * Called from TurnFinalizer after the LLM turn completes. Captures
 * the agent's output as the pending-deferred step's output, advances
 * the state machine, and fires events.
 */
export async function observeTurnCompletion(params: {
  db: ISqliteDriver;
  slotId: string;
  accumulatedText: string;
  turnNumber: number;
}): Promise<void> {
  const { db, slotId, accumulatedText, turnNumber } = params;
  const run = getActiveRun(db, slotId);
  if (!run) return;
  const pending = run.stateJson.__pendingStep as { stepId: string } | undefined;
  if (!pending) return;

  const snapshot = JSON.parse(run.graphSnapshot) as WorkflowDefinition;
  const node = snapshot.nodes.find((n) => n.id === pending.stepId);
  if (!node) return;

  const state = { ...run.stateJson };
  delete state.__pendingStep;
  state[pending.stepId] = { llmOutput: accumulatedText };
  const completed = [...run.completedStepIds, pending.stepId];
  const remaining = run.activeStepIds.filter((id) => id !== pending.stepId);
  const next = computeNextActiveSteps(node, { llmOutput: accumulatedText }, snapshot.connections);
  const newActive = [...remaining, ...next];

  updateRunState(db, run.id, state);
  updateRunSteps(db, run.id, { activeStepIds: newActive, completedStepIds: completed });
  appendTrace(db, run.id, {
    timestamp: Date.now(),
    kind: 'step_completed',
    stepId: pending.stepId,
    stepLabel: node.name,
    turnNumber,
  });
  dispatcherEvents.emit('step-completed', {
    runId: run.id,
    stepId: pending.stepId,
    outputs: { llmOutput: accumulatedText },
  });

  if (newActive.length === 0) {
    updateRunStatus(db, run.id, 'completed');
    const final = getActiveRun(db, slotId) ?? run;
    dispatcherEvents.emit('run-completed', final);
  }
}

// ── Admin operations (exposed via IPC in a later commit) ─────────────────────

export function pauseRun(db: ISqliteDriver, runId: string): void {
  updateRunStatus(db, runId, 'paused');
  appendTrace(db, runId, { timestamp: Date.now(), kind: 'paused' });
}

export function resumeRun(db: ISqliteDriver, runId: string): void {
  updateRunStatus(db, runId, 'running');
  appendTrace(db, runId, { timestamp: Date.now(), kind: 'resumed' });
}

export function abortRun(db: ISqliteDriver, runId: string): void {
  abortRunInState(db, runId);
  appendTrace(db, runId, { timestamp: Date.now(), kind: 'aborted' });
  const row = db.prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId);
  if (row) dispatcherEvents.emit('run-failed', row);
}

export function skipStep(db: ISqliteDriver, runId: string, stepId: string): void {
  const row = db.prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return;
  const snapshot = JSON.parse(row.graph_snapshot as string) as WorkflowDefinition;
  const node = snapshot.nodes.find((n) => n.id === stepId);
  if (!node) return;
  const active = JSON.parse(row.active_step_ids as string) as string[];
  const completed = JSON.parse(row.completed_step_ids as string) as string[];
  const newActive = active.filter((s) => s !== stepId);
  const newCompleted = [...completed, stepId];
  const next = computeNextActiveSteps(node, {}, snapshot.connections);
  updateRunSteps(db, runId, {
    activeStepIds: [...newActive, ...next],
    completedStepIds: newCompleted,
  });
  appendTrace(db, runId, {
    timestamp: Date.now(),
    kind: 'step_completed',
    stepId,
    details: { reason: 'skipped' },
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Walk the active-step frontier. Pops one step at a time; tool/sprint
 * steps run in-dispatcher; a prompt step sets up injection and stops
 * the walk. Hard-capped at MAX_STEPS_PER_TURN to prevent dispatcher
 * runaway on a workflow graph that accidentally loops on its non-
 * deferred path.
 */
async function walkActiveSteps(args: {
  db: ISqliteDriver;
  run: AgentWorkflowRun;
  slotId: string;
  teamId?: string;
  conversationId?: string;
  agentGalleryId?: string;
  allowedTools: string[];
  turnNumber: number;
}): Promise<TurnInjection | null> {
  const { db, run, slotId, teamId, conversationId, agentGalleryId, allowedTools, turnNumber } = args;
  const snapshot = JSON.parse(run.graphSnapshot) as WorkflowDefinition;

  let nextActive = [...run.activeStepIds];
  const completed = [...run.completedStepIds];
  const failed = [...run.failedStepIds];
  let state = { ...run.stateJson };

  for (let i = 0; i < MAX_STEPS_PER_TURN; i++) {
    if (nextActive.length === 0) break;
    const stepId = nextActive.shift()!;
    const node = snapshot.nodes.find((n) => n.id === stepId);
    if (!node) continue;

    // IAM gate.
    const requiredTool = getRequiredToolForNode(node);
    if (requiredTool && !isToolAllowed(requiredTool, allowedTools)) {
      const err = new WorkflowStepError('IAM_DENIED', `Tool ${requiredTool} not permitted`, requiredTool);
      recordStepFailure(db, run.id, stepId, err, failed, turnNumber);
      updateRunSteps(db, run.id, { failedStepIds: failed });
      if (node.onError === 'continue') continue;
      updateRunStatus(db, run.id, 'failed');
      const final = getActiveRun(db, slotId) ?? run;
      dispatcherEvents.emit('run-failed', final);
      return null;
    }

    // Dispatch handler (with retry).
    const agentContext: HandlerAgentContext = {
      runId: run.id,
      slotId,
      teamId,
      conversationId,
      agentGalleryId,
      state,
    };
    const inputData = { [AGENT_CONTEXT_KEY]: agentContext, ...state };
    let output: Record<string, unknown>;
    try {
      output = await dispatchHandler(db, node, inputData, run.id);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      recordStepFailure(db, run.id, stepId, e, failed, turnNumber);
      updateRunSteps(db, run.id, { failedStepIds: failed });
      if (node.onError === 'continue') continue;
      updateRunStatus(db, run.id, 'failed');
      const final = getActiveRun(db, slotId) ?? run;
      dispatcherEvents.emit('run-failed', final);
      return null;
    }

    if (isDeferredOutput(output)) {
      // Prompt step — stash pending + return injection.
      state = { ...state, __pendingStep: { stepId, output } };
      updateRunState(db, run.id, state);
      updateRunSteps(db, run.id, {
        activeStepIds: [stepId, ...nextActive],
        completedStepIds: completed,
        failedStepIds: failed,
      });
      appendTrace(db, run.id, {
        timestamp: Date.now(),
        kind: 'step_started',
        stepId,
        stepLabel: node.name,
        turnNumber,
      });
      return {
        injectedContext: buildInjectionBlock(snapshot, output, node, completed.length),
        runId: run.id,
        stepId,
      };
    }

    // Non-deferred — persist + advance.
    state = { ...state, [stepId]: output };
    completed.push(stepId);
    const next = computeNextActiveSteps(node, output, snapshot.connections);
    nextActive = [...nextActive, ...next];
    updateRunSteps(db, run.id, { activeStepIds: nextActive, completedStepIds: completed });
    updateRunState(db, run.id, state);
    appendTrace(db, run.id, {
      timestamp: Date.now(),
      kind: 'step_completed',
      stepId,
      stepLabel: node.name,
      turnNumber,
    });
    dispatcherEvents.emit('step-completed', { runId: run.id, stepId, outputs: output });
  }

  // Pure tool chain completed this turn with no remaining steps → mark done.
  if (nextActive.length === 0) {
    updateRunSteps(db, run.id, { activeStepIds: [] });
    updateRunStatus(db, run.id, 'completed');
    const final = getActiveRun(db, slotId) ?? run;
    dispatcherEvents.emit('run-completed', final);
  }
  return null;
}

async function dispatchHandler(
  db: ISqliteDriver,
  node: WorkflowNode,
  inputData: Record<string, unknown>,
  runId: string
): Promise<Record<string, unknown>> {
  const handler = getRegisteredHandler(node.type);
  if (!handler) throw new Error(`No handler registered for node type: ${node.type}`);

  const ctx: Parameters<NodeHandler>[2] = {
    db,
    executionId: runId,
    workflowId: runId,
    nodeOutputs: new Map<string, Record<string, unknown>>(),
    cancelled: false,
  };

  const max = node.retryConfig?.maxRetries ?? 0;
  const backoff = node.retryConfig?.backoffMs ?? 1000;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= max) {
    try {
      return await handler(node, inputData, ctx);
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > max) break;
      await new Promise((r) => setTimeout(r, backoff * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function computeNextActiveSteps(
  completedNode: WorkflowNode,
  output: Record<string, unknown>,
  connections: WorkflowConnection[]
): string[] {
  const branch = output.__branch as string | undefined;
  const outgoing = connections.filter((c) => c.fromNodeId === completedNode.id);
  if (branch && completedNode.type === 'condition') {
    return outgoing.filter((c) => c.fromOutput === branch).map((c) => c.toNodeId);
  }
  return outgoing.map((c) => c.toNodeId);
}

function isDeferredOutput(output: Record<string, unknown>): output is PromptDeferredOutput & Record<string, unknown> {
  return output.__deferred === true && typeof output.promptTemplate === 'string';
}

function buildInjectionBlock(
  workflow: WorkflowDefinition,
  output: PromptDeferredOutput & Record<string, unknown>,
  node: WorkflowNode,
  completedCount: number
): string {
  const totalSteps = workflow.nodes.filter((n) => n.type !== 'trigger' && n.type !== 'webhook').length;
  const stepIndex = completedCount + 1;
  const criteriaLine = output.completionCriteria ? `\nAcceptance criteria: ${output.completionCriteria}` : '';
  return [
    `[Workflow: ${workflow.name} · Step ${stepIndex} of ${totalSteps}]`,
    `Completed: ${completedCount}. Do not skip ahead.`,
    `Current step: ${node.name || node.id}`,
    output.promptTemplate + criteriaLine,
  ].join('\n');
}

function recordStepFailure(
  db: ISqliteDriver,
  runId: string,
  stepId: string,
  err: Error,
  failedSteps: AgentWorkflowRun['failedStepIds'],
  turnNumber: number
): void {
  const existing = failedSteps.find((f) => f.stepId === stepId);
  if (existing) {
    existing.attempts += 1;
    existing.lastError = err.message;
  } else {
    failedSteps.push({ stepId, attempts: 1, lastError: err.message });
  }
  const code = err instanceof WorkflowStepError ? err.code : 'TOOL_FAILED';
  appendTrace(db, runId, {
    timestamp: Date.now(),
    kind: 'step_failed',
    stepId,
    turnNumber,
    details: { code, message: err.message },
  });
}

function loadWorkflowDefinition(db: ISqliteDriver, workflowId: string): WorkflowDefinition | null {
  const row = db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(workflowId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    nodes: JSON.parse((row.nodes as string) ?? '[]') as WorkflowNode[],
    connections: JSON.parse((row.connections as string) ?? '[]') as WorkflowConnection[],
    settings: JSON.parse((row.settings as string) ?? '{}') as Record<string, unknown>,
    enabled: (row.enabled as number) === 1,
    version: row.version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    canonicalId: (row.canonical_id as string | null) ?? undefined,
    source: (row.source as 'local' | 'builtin' | 'master' | null) ?? undefined,
    category: (row.category as string | null) ?? undefined,
    managedByVersion: (row.managed_by_version as number | null) ?? undefined,
    publishedToFleet: (row.published_to_fleet as number) === 1,
  };
}
