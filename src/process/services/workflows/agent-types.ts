/**
 * @license Apache-2.0
 * Agent Workflow Builder — types specific to the agent-binding layer.
 *
 * These types extend TitanX's existing n8n-style workflow engine
 * (see ./types.ts for the shared DAG primitives — WorkflowDefinition,
 * WorkflowNode, WorkflowConnection). The agent-binding layer adds two
 * new concepts that don't exist in the governance workflow surface:
 *
 *   - **Binding** — links a WorkflowDefinition row to either an
 *     `agent_gallery` template (default-at-hire) or a specific
 *     `team_agents.slot_id` (operator override at hire time). One
 *     agent slot gets at most one active binding; template-level
 *     bindings apply to every hire of that template unless
 *     superseded by a slot-level binding.
 *
 *   - **Run** — the per-agent multi-turn state envelope. Unlike the
 *     existing `workflow_executions` (which records one-shot
 *     governance DAG runs), an agent workflow run executes *one step
 *     per agent turn* across many turns. The run persists a
 *     `graph_snapshot` captured at run-start so definition edits
 *     mid-run don't disrupt the current execution — the run finishes
 *     on the version it began with; subsequent runs pick up the edit.
 *
 * The shape below intentionally mirrors the column layout of
 * `workflow_bindings` and `agent_workflow_runs` (migration v74) so
 * the CRUD layer can round-trip without shape manipulation.
 */

/**
 * Binds a workflow to an agent scope. Exactly one of
 * `agentGalleryId` or `slotId` must be set (DB-enforced CHECK
 * constraint). `teamId` is optional and only meaningful for
 * slot-level bindings; it records the team context at hire time for
 * audit visibility.
 */
export type WorkflowBinding = {
  id: string;
  workflowDefinitionId: string;
  /** Template-level binding. Applies to every hire of this template. */
  agentGalleryId?: string;
  /** Slot-level binding. Supersedes template-level for this specific hire. */
  slotId?: string;
  teamId?: string;
  boundAt: number;
  /** Optional TTL — binding is inactive after this timestamp. */
  expiresAt?: number;
};

/** Input for creating a new binding. One of agentGalleryId or slotId required. */
export type CreateWorkflowBindingInput = {
  workflowDefinitionId: string;
  agentGalleryId?: string;
  slotId?: string;
  teamId?: string;
  expiresAt?: number;
};

/**
 * Runtime status of an agent workflow run. Most runs spend most of
 * their life in `running` between turn boundaries; `paused` indicates
 * a human gate or operator-initiated pause; `failed` / `completed` are
 * terminal.
 */
export type AgentWorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused';

/**
 * Per-agent multi-turn run state. Persisted to `agent_workflow_runs`.
 *
 * The `graphSnapshot` field holds the JSON-serialized WorkflowDefinition
 * captured at run-start; see ./agent-types.ts module comment for why.
 * `stateJson` holds workflow-level variables, loop counters, and any
 * output envelopes written by completed steps; node handlers read it
 * to template their arguments and write back their results.
 *
 * `activeStepIds` supports parallel branches (a `parallel.fan_out` node
 * can set multiple steps active simultaneously); most workflows in
 * Phase 1 will have exactly one active step at a time. The `failedStepIds`
 * field tracks per-step retry counts as an ordered array of
 * `{stepId, attempts, lastError}` entries.
 */
export type AgentWorkflowRun = {
  id: string;
  workflowDefinitionId: string;
  /** Version snapshot; upgrades don't disrupt in-flight runs. */
  definitionVersion: number;
  /** JSON-serialized WorkflowDefinition captured at run-start. */
  graphSnapshot: string;
  agentSlotId: string;
  teamId?: string;
  conversationId?: string;
  status: AgentWorkflowRunStatus;
  /** Node IDs whose inputs are now satisfied and are ready to dispatch. */
  activeStepIds: string[];
  /** Node IDs whose handler returned success. Drives edge traversal. */
  completedStepIds: string[];
  /** Per-step retry state: { stepId, attempts, lastError }[]. */
  failedStepIds: Array<{ stepId: string; attempts: number; lastError?: string }>;
  /** Workflow-level variables + step outputs. Freeform JSON. */
  stateJson: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
  /**
   * Ordered event trace for the debug viewer: step-started,
   * step-completed, step-failed, step-retry, pause, resume, abort.
   * Capped at 200 entries; older entries rotate out.
   */
  trace: WorkflowRunTraceEntry[];
};

/** A single event in the run's trace log (bounded, oldest-first). */
export type WorkflowRunTraceEntry = {
  timestamp: number;
  kind: 'step_started' | 'step_completed' | 'step_failed' | 'step_retry' | 'paused' | 'resumed' | 'aborted';
  stepId?: string;
  stepLabel?: string;
  turnNumber?: number;
  details?: Record<string, unknown>;
};

/**
 * Context passed to a step handler by the agent dispatcher. Distinct
 * from the existing engine's internal ExecutionContext (see engine.ts)
 * — the agent dispatcher runs one step per turn, so the context
 * carries just the current run state + DB driver, not a full graph
 * execution state map.
 */
export type StepDispatchContext = {
  runId: string;
  workflowDefinitionId: string;
  agentSlotId: string;
  teamId?: string;
  conversationId?: string;
  /** Current workflow-level state (read + write). Persisted after handler returns. */
  state: Record<string, unknown>;
  /** Turn number this dispatch is associated with (for trace correlation). */
  turnNumber: number;
};

/**
 * Error emitted by a step handler when IAM rejects the underlying
 * tool call. Handled specially by the dispatcher: routes through the
 * node's `onError` edge rather than failing the whole run silently,
 * and surfaces the denied tool in the debug viewer so operators can
 * add the missing policy binding.
 */
export class WorkflowStepError extends Error {
  readonly code: 'IAM_DENIED' | 'SCHEMA_VIOLATION' | 'TOOL_FAILED' | 'TIMEOUT' | 'PAUSED';
  readonly deniedTool?: string;
  constructor(code: WorkflowStepError['code'], message: string, deniedTool?: string) {
    super(message);
    this.name = 'WorkflowStepError';
    this.code = code;
    this.deniedTool = deniedTool;
  }
}
