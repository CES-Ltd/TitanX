/**
 * @license Apache-2.0
 * Agent Workflow Builder — agent_workflow_runs CRUD + helpers.
 *
 * An agent workflow run is the per-agent, per-binding multi-turn
 * state envelope. Distinct from the existing `workflow_executions`
 * table (one-shot governance runs): agent workflow runs execute
 * *one step per agent turn* across many turns, so the row persists
 * across turn boundaries and survives app relaunches.
 *
 * Key design points:
 *
 *   - `graphSnapshot` — JSON-serialized WorkflowDefinition captured
 *     at run-start. If an operator edits the source definition while
 *     this run is mid-flight, the run finishes on the snapshot;
 *     subsequent runs pick up the edit. Trades a tiny bit of disk
 *     for upgrade stability.
 *
 *   - `activeStepIds` — set of step IDs ready for dispatch on the
 *     next turn. Phase 1 workflows have exactly one active step at a
 *     time, but the shape already supports parallel branches for a
 *     future `parallel.fan_out` handler (plan § Phase 2/3).
 *
 *   - `failedStepIds` — ordered list of
 *     `{ stepId, attempts, lastError? }`. Drives the engine's retry
 *     loop (reused from `executeNode` — see engine.ts:297-319).
 *
 *   - `trace` — bounded event log for the debug viewer. Capped at
 *     `TRACE_MAX_ENTRIES`; older entries rotate out. Bounded because
 *     the trace is UI-facing, not the primary audit source (that's
 *     activity_log).
 *
 * JSON serialization boundary — TS types hold parsed arrays/objects;
 * SQL columns hold JSON strings. `rowToRun()` and the write helpers
 * handle the bridge so callers never see raw JSON.
 *
 * Concurrency — the `appendTrace()` read-modify-write is safe because
 * `AgentWorkflowBusyGuard` serializes all dispatches for a given slot.
 * One slot → at most one in-flight dispatch → no concurrent write to
 * that slot's run row.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { AgentWorkflowRun, AgentWorkflowRunStatus, WorkflowRunTraceEntry } from './agent-types';
import type { WorkflowConnection, WorkflowDefinition, WorkflowNode } from './types';

/** Trace buffer cap. Oldest entries rotate out when exceeded. */
export const TRACE_MAX_ENTRIES = 200;

/** Cap on the list-runs `limit` param so callers can't request unbounded scans. */
const LIST_RUNS_HARD_LIMIT = 500;

/** Input for {@link createRun}. */
export type CreateAgentWorkflowRunInput = {
  workflow: WorkflowDefinition;
  agentSlotId: string;
  teamId?: string;
  conversationId?: string;
};

/**
 * Create a new run. Captures graph_snapshot from the supplied
 * definition, computes entry steps, and starts in `'running'` so the
 * dispatcher picks it up on the next turn without an extra state
 * transition. The run row is the single source of truth for dispatch
 * decisions; the snapshot is the single source of truth for the graph.
 */
export function createRun(db: ISqliteDriver, input: CreateAgentWorkflowRunInput): AgentWorkflowRun {
  const { workflow, agentSlotId, teamId, conversationId } = input;
  const id = crypto.randomUUID();
  const now = Date.now();
  const entrySteps = findEntryStepIds(workflow.nodes, workflow.connections);
  const snapshot = JSON.stringify(workflow);

  db.prepare(
    `INSERT INTO agent_workflow_runs
       (id, workflow_definition_id, definition_version, graph_snapshot,
        agent_slot_id, team_id, conversation_id, status,
        active_step_ids, completed_step_ids, failed_step_ids,
        state_json, started_at, trace_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    workflow.id,
    workflow.version,
    snapshot,
    agentSlotId,
    teamId ?? null,
    conversationId ?? null,
    JSON.stringify(entrySteps),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify({}),
    now,
    JSON.stringify([])
  );

  return {
    id,
    workflowDefinitionId: workflow.id,
    definitionVersion: workflow.version,
    graphSnapshot: snapshot,
    agentSlotId,
    teamId,
    conversationId,
    status: 'running',
    activeStepIds: entrySteps,
    completedStepIds: [],
    failedStepIds: [],
    stateJson: {},
    startedAt: now,
    trace: [],
  };
}

export function getRun(db: ISqliteDriver, runId: string): AgentWorkflowRun | null {
  const row = db.prepare('SELECT * FROM agent_workflow_runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRun(row) : null;
}

/**
 * Most recent non-terminal run for a slot (status `running` or
 * `paused`). A slot has at most one such run at any time — this is
 * the dispatcher's "should I advance a step this turn?" lookup.
 * Returns null when there's no in-flight run.
 */
export function getActiveRun(db: ISqliteDriver, slotId: string): AgentWorkflowRun | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_workflow_runs
       WHERE agent_slot_id = ? AND status IN ('running', 'paused')
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(slotId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(
  db: ISqliteDriver,
  filters: { slotId?: string; teamId?: string; status?: AgentWorkflowRunStatus; limit?: number } = {}
): AgentWorkflowRun[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.slotId) {
    clauses.push('agent_slot_id = ?');
    args.push(filters.slotId);
  }
  if (filters.teamId) {
    clauses.push('team_id = ?');
    args.push(filters.teamId);
  }
  if (filters.status) {
    clauses.push('status = ?');
    args.push(filters.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(filters.limit ?? 100, LIST_RUNS_HARD_LIMIT));
  const rows = db
    .prepare(`SELECT * FROM agent_workflow_runs ${where} ORDER BY started_at DESC LIMIT ${limit}`)
    .all(...args) as Array<Record<string, unknown>>;
  return rows.map(rowToRun);
}

/**
 * Transition a run to a new status. For terminal states
 * (`completed`/`failed`), also stamps `completed_at` in the same
 * statement so callers don't need a second write.
 */
export function updateRunStatus(db: ISqliteDriver, runId: string, status: AgentWorkflowRunStatus): void {
  if (status === 'completed' || status === 'failed') {
    db.prepare('UPDATE agent_workflow_runs SET status = ?, completed_at = ? WHERE id = ?').run(
      status,
      Date.now(),
      runId
    );
  } else {
    db.prepare('UPDATE agent_workflow_runs SET status = ? WHERE id = ?').run(status, runId);
  }
}

/**
 * Patch the step-id arrays. Each param is optional — only the
 * supplied fields are written, so a caller can advance one array
 * without round-tripping the others.
 */
export function updateRunSteps(
  db: ISqliteDriver,
  runId: string,
  steps: {
    activeStepIds?: string[];
    completedStepIds?: string[];
    failedStepIds?: AgentWorkflowRun['failedStepIds'];
  }
): void {
  const setClauses: string[] = [];
  const args: unknown[] = [];
  if (steps.activeStepIds !== undefined) {
    setClauses.push('active_step_ids = ?');
    args.push(JSON.stringify(steps.activeStepIds));
  }
  if (steps.completedStepIds !== undefined) {
    setClauses.push('completed_step_ids = ?');
    args.push(JSON.stringify(steps.completedStepIds));
  }
  if (steps.failedStepIds !== undefined) {
    setClauses.push('failed_step_ids = ?');
    args.push(JSON.stringify(steps.failedStepIds));
  }
  if (setClauses.length === 0) return;
  args.push(runId);
  db.prepare(`UPDATE agent_workflow_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...args);
}

/** Overwrite the workflow-level state bag with the supplied record. */
export function updateRunState(db: ISqliteDriver, runId: string, state: Record<string, unknown>): void {
  db.prepare('UPDATE agent_workflow_runs SET state_json = ? WHERE id = ?').run(JSON.stringify(state), runId);
}

/**
 * Append a trace entry. Reads the current trace, trims to
 * `TRACE_MAX_ENTRIES` (oldest-first), writes back. The dispatcher's
 * busy guard serializes dispatches per slot, so the read-modify-write
 * is safe despite not being in a single statement.
 */
export function appendTrace(db: ISqliteDriver, runId: string, entry: WorkflowRunTraceEntry): void {
  const row = db.prepare('SELECT trace_json FROM agent_workflow_runs WHERE id = ?').get(runId) as
    | { trace_json: string | null }
    | undefined;
  if (!row) return;
  const existing: WorkflowRunTraceEntry[] = row.trace_json
    ? (JSON.parse(row.trace_json) as WorkflowRunTraceEntry[])
    : [];
  existing.push(entry);
  if (existing.length > TRACE_MAX_ENTRIES) {
    existing.splice(0, existing.length - TRACE_MAX_ENTRIES);
  }
  db.prepare('UPDATE agent_workflow_runs SET trace_json = ? WHERE id = ?').run(JSON.stringify(existing), runId);
}

/** Convenience wrapper for the terminal states. */
export function completeRun(
  db: ISqliteDriver,
  runId: string,
  status: Extract<AgentWorkflowRunStatus, 'completed' | 'failed'>
): void {
  updateRunStatus(db, runId, status);
}

/**
 * Abort an in-flight run. Force-moves status from running/paused to
 * failed and stamps completed_at. No-ops on already-terminal runs
 * (via the WHERE clause) — safe to call repeatedly.
 */
export function abortRun(db: ISqliteDriver, runId: string): void {
  db.prepare(
    "UPDATE agent_workflow_runs SET status = 'failed', completed_at = ? WHERE id = ? AND status IN ('running', 'paused')"
  ).run(Date.now(), runId);
}

/**
 * Compute the set of nodes that should be active at run-start. An
 * entry step is any non-trigger node whose upstream nodes are all
 * triggers (or that has no upstream at all). Matches the existing
 * one-shot engine's treatment of triggers (engine.ts:192-196) —
 * triggers are sources that supply input, not executable steps.
 *
 * Exported for the seeder and tests; dispatcher consumes it via
 * `createRun()`.
 */
export function findEntryStepIds(nodes: WorkflowNode[], connections: WorkflowConnection[]): string[] {
  const triggerIds = new Set(nodes.filter((n) => n.type === 'trigger' || n.type === 'webhook').map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const conn of connections) {
    const list = incoming.get(conn.toNodeId);
    if (list) list.push(conn.fromNodeId);
  }
  return nodes
    .filter((node) => {
      if (triggerIds.has(node.id)) return false;
      // [].every(...) === true by spec, so this covers both "no upstream"
      // and "only-trigger upstream" in a single predicate.
      const upstream = incoming.get(node.id) ?? [];
      return upstream.every((u) => triggerIds.has(u));
    })
    .map((n) => n.id);
}

export function rowToRun(row: Record<string, unknown>): AgentWorkflowRun {
  return {
    id: row.id as string,
    workflowDefinitionId: row.workflow_definition_id as string,
    definitionVersion: row.definition_version as number,
    graphSnapshot: row.graph_snapshot as string,
    agentSlotId: row.agent_slot_id as string,
    teamId: (row.team_id as string | null) ?? undefined,
    conversationId: (row.conversation_id as string | null) ?? undefined,
    status: row.status as AgentWorkflowRunStatus,
    activeStepIds: parseArray<string>(row.active_step_ids),
    completedStepIds: parseArray<string>(row.completed_step_ids),
    failedStepIds: parseArray<AgentWorkflowRun['failedStepIds'][number]>(row.failed_step_ids),
    stateJson: parseObject(row.state_json),
    startedAt: row.started_at as number,
    completedAt: (row.completed_at as number | null) ?? undefined,
    trace: parseArray<WorkflowRunTraceEntry>(row.trace_json),
  };
}

function parseArray<T>(raw: unknown): T[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
