/**
 * @license Apache-2.0
 * Trace system — LangSmith-compatible hierarchical tracing with token attribution.
 * Provides parent-child run tracking, feedback collection, and OTel correlation.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan } from '../telemetry';

// ── Types ────────────────────────────────────────────────────────────────────

export type RunType = 'chain' | 'agent' | 'tool' | 'llm' | 'retriever' | 'workflow';
export type RunStatus = 'running' | 'completed' | 'error';

export type TraceRun = {
  id: string;
  parentRunId?: string;
  rootRunId: string;
  runType: RunType;
  name: string;
  status: RunStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  startTime: number;
  endTime?: number;
  agentSlotId?: string;
  teamId?: string;
  workflowExecutionId?: string;
  otelTraceId?: string;
  otelSpanId?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type TraceFeedback = {
  id: string;
  runId: string;
  userId: string;
  score: number;
  value?: string;
  comment?: string;
  category: string;
  createdAt: number;
};

export type RunHandle = {
  runId: string;
  end: (outputs?: Record<string, unknown>, error?: string) => void;
  setTokens: (inputTokens: number, outputTokens: number, costCents?: number) => void;
  addTag: (tag: string) => void;
  setMetadata: (key: string, value: unknown) => void;
  createChild: (name: string, runType: RunType, inputs?: Record<string, unknown>) => RunHandle;
};

// ── Core functions ───────────────────────────────────────────────────────────

/** Start a new trace run. Returns a RunHandle for lifecycle management. */
export function startRun(
  db: ISqliteDriver,
  name: string,
  runType: RunType,
  options?: {
    parentRunId?: string;
    inputs?: Record<string, unknown>;
    agentSlotId?: string;
    teamId?: string;
    workflowExecutionId?: string;
  }
): RunHandle {
  const id = crypto.randomUUID();
  const now = Date.now();
  const parentRunId = options?.parentRunId;

  // Determine root run ID
  let rootRunId: string = id;
  if (parentRunId) {
    const parent = db.prepare('SELECT root_run_id FROM trace_runs WHERE id = ?').get(parentRunId) as
      | { root_run_id: string }
      | undefined;
    rootRunId = parent?.root_run_id ?? id;
  }

  const otelSpan = startSpan('titanx.trace', `trace.${runType}.${name}`, {
    run_id: id,
    run_type: runType,
  });

  db.prepare(
    `INSERT INTO trace_runs (id, parent_run_id, root_run_id, run_type, name, status, inputs, outputs, start_time, agent_slot_id, team_id, workflow_execution_id, tags, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, '{}', ?, ?, ?, ?, '[]', '{}', ?)`
  ).run(
    id,
    parentRunId ?? null,
    rootRunId,
    runType,
    name,
    JSON.stringify(options?.inputs ?? {}),
    now,
    options?.agentSlotId ?? null,
    options?.teamId ?? null,
    options?.workflowExecutionId ?? null,
    now
  );

  const handle: RunHandle = {
    runId: id,
    end: (outputs, error) => {
      const status: RunStatus = error ? 'error' : 'completed';
      db.prepare('UPDATE trace_runs SET status = ?, outputs = ?, error = ?, end_time = ? WHERE id = ?').run(
        status,
        JSON.stringify(outputs ?? {}),
        error ?? null,
        Date.now(),
        id
      );
      otelSpan.setStatus(error ? 'error' : 'ok', error);
      otelSpan.end();
    },
    setTokens: (inputTokens, outputTokens, costCents) => {
      const total = inputTokens + outputTokens;
      db.prepare(
        'UPDATE trace_runs SET input_tokens = ?, output_tokens = ?, total_tokens = ?, cost_cents = ? WHERE id = ?'
      ).run(inputTokens, outputTokens, total, costCents ?? 0, id);
    },
    addTag: (tag) => {
      const row = db.prepare('SELECT tags FROM trace_runs WHERE id = ?').get(id) as { tags: string } | undefined;
      const tags: string[] = row ? JSON.parse(row.tags) : [];
      if (!tags.includes(tag)) {
        tags.push(tag);
        db.prepare('UPDATE trace_runs SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
      }
    },
    setMetadata: (key, value) => {
      const row = db.prepare('SELECT metadata FROM trace_runs WHERE id = ?').get(id) as
        | { metadata: string }
        | undefined;
      const meta: Record<string, unknown> = row ? JSON.parse(row.metadata) : {};
      meta[key] = value;
      db.prepare('UPDATE trace_runs SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);
    },
    createChild: (childName, childType, inputs) => {
      return startRun(db, childName, childType, {
        parentRunId: id,
        inputs,
        agentSlotId: options?.agentSlotId,
        teamId: options?.teamId,
        workflowExecutionId: options?.workflowExecutionId,
      });
    },
  };

  return handle;
}

/** Get a single run */
export function getRun(db: ISqliteDriver, runId: string): TraceRun | null {
  const row = db.prepare('SELECT * FROM trace_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
  return row ? rowToRun(row) : null;
}

/** Get the full trace tree for a root run */
export function getTraceTree(db: ISqliteDriver, rootRunId: string): TraceRun[] {
  const rows = db
    .prepare('SELECT * FROM trace_runs WHERE root_run_id = ? ORDER BY start_time ASC')
    .all(rootRunId) as Array<Record<string, unknown>>;
  return rows.map(rowToRun);
}

/** List runs with filters */
export function listRuns(
  db: ISqliteDriver,
  filters?: { rootRunId?: string; agentSlotId?: string; runType?: string; limit?: number }
): TraceRun[] {
  let query = 'SELECT * FROM trace_runs WHERE 1=1';
  const args: unknown[] = [];

  if (filters?.rootRunId) {
    query += ' AND root_run_id = ?';
    args.push(filters.rootRunId);
  }
  if (filters?.agentSlotId) {
    query += ' AND agent_slot_id = ?';
    args.push(filters.agentSlotId);
  }
  if (filters?.runType) {
    query += ' AND run_type = ?';
    args.push(filters.runType);
  }

  query += ' ORDER BY start_time DESC LIMIT ?';
  args.push(filters?.limit ?? 50);

  return (db.prepare(query).all(...args) as Array<Record<string, unknown>>).map(rowToRun);
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export function addFeedback(
  db: ISqliteDriver,
  runId: string,
  userId: string,
  score: number,
  value?: string,
  comment?: string,
  category?: string
): TraceFeedback {
  const id = crypto.randomUUID();
  const now = Date.now();
  const cat = category ?? 'general';

  db.prepare(
    'INSERT INTO trace_feedback (id, run_id, user_id, score, value, comment, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, runId, userId, score, value ?? null, comment ?? null, cat, now);

  logActivity(db, {
    userId,
    actorType: 'user',
    actorId: userId,
    action: 'trace.feedback_added',
    entityType: 'trace_feedback',
    entityId: id,
    details: { runId, score, category: cat },
  });

  return { id, runId, userId, score, value, comment, category: cat, createdAt: now };
}

export function listFeedback(db: ISqliteDriver, runId: string): TraceFeedback[] {
  return (
    db.prepare('SELECT * FROM trace_feedback WHERE run_id = ? ORDER BY created_at DESC').all(runId) as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    userId: r.user_id as string,
    score: r.score as number,
    value: (r.value as string) ?? undefined,
    comment: (r.comment as string) ?? undefined,
    category: (r.category as string) ?? 'general',
    createdAt: r.created_at as number,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToRun(row: Record<string, unknown>): TraceRun {
  return {
    id: row.id as string,
    parentRunId: (row.parent_run_id as string) ?? undefined,
    rootRunId: row.root_run_id as string,
    runType: row.run_type as RunType,
    name: row.name as string,
    status: row.status as RunStatus,
    inputs: JSON.parse((row.inputs as string) || '{}'),
    outputs: JSON.parse((row.outputs as string) || '{}'),
    error: (row.error as string) ?? undefined,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    totalTokens: (row.total_tokens as number) ?? 0,
    costCents: (row.cost_cents as number) ?? 0,
    startTime: row.start_time as number,
    endTime: (row.end_time as number) ?? undefined,
    agentSlotId: (row.agent_slot_id as string) ?? undefined,
    teamId: (row.team_id as string) ?? undefined,
    workflowExecutionId: (row.workflow_execution_id as string) ?? undefined,
    otelTraceId: (row.otel_trace_id as string) ?? undefined,
    otelSpanId: (row.otel_span_id as string) ?? undefined,
    tags: JSON.parse((row.tags as string) || '[]'),
    metadata: JSON.parse((row.metadata as string) || '{}'),
    createdAt: row.created_at as number,
  };
}
