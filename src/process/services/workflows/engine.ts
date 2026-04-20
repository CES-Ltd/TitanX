/**
 * @license Apache-2.0
 * Workflow DAG execution engine — n8n-inspired node graph execution.
 * Performs topological sort, executes nodes with retry/error handling,
 * records full execution history for debugging.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan, getCounter } from '../telemetry';
import type {
  WorkflowDefinition,
  WorkflowExecution,
  NodeExecution,
  WorkflowNode,
  WorkflowConnection,
  ExecutionStatus,
  NodeExecutionStatus,
} from './types';

// ── Node handler registry ────────────────────────────────────────────────────

type NodeHandler = (
  node: WorkflowNode,
  inputData: Record<string, unknown>,
  context: ExecutionContext
) => Promise<Record<string, unknown>>;

type ExecutionContext = {
  db: ISqliteDriver;
  executionId: string;
  workflowId: string;
  nodeOutputs: Map<string, Record<string, unknown>>;
  cancelled: boolean;
};

const nodeHandlers = new Map<string, NodeHandler>();

/** Register a node type handler */
export function registerNodeHandler(nodeType: string, handler: NodeHandler): void {
  nodeHandlers.set(nodeType, handler);
}

/**
 * v2.6.0 · Agent Workflow Builder — look up a handler by node type.
 *
 * Governance callers use `executeWorkflow()` / internal `executeNode()`
 * and never need this. The agent-workflow dispatcher
 * (agentDispatcher.ts) dispatches one step per turn without the
 * full-graph execution envelope, so it looks up handlers directly.
 * Purely additive — zero impact on the existing one-shot flow.
 */
export function getRegisteredHandler(nodeType: string): NodeHandler | undefined {
  return nodeHandlers.get(nodeType);
}

/** v2.6.0 — NodeHandler type re-exported for the dispatcher's typed context build. */
export type { NodeHandler };

// ── Built-in node handlers ───────────────────────────────────────────────────

registerNodeHandler('trigger', async (_node, inputData) => inputData);

registerNodeHandler('transform', async (node, inputData) => {
  const mapping = (node.parameters.mapping ?? {}) as Record<string, string>;
  const output: Record<string, unknown> = { ...inputData };
  for (const [key, expr] of Object.entries(mapping)) {
    output[key] = evaluateExpression(expr, inputData);
  }
  return output;
});

registerNodeHandler('condition', async (node, inputData) => {
  const expr = (node.parameters.condition as string) ?? 'true';
  const result = evaluateExpression(expr, inputData);
  return { ...inputData, __branch: result ? 'true' : 'false' };
});

registerNodeHandler('loop', async (node, inputData) => {
  const items = (inputData[(node.parameters.arrayField as string) ?? 'items'] as unknown[]) ?? [];
  return { ...inputData, __loopItems: items, __loopCount: items.length };
});

registerNodeHandler('action', async (node, inputData) => {
  // Action nodes execute tool calls — for now return input as passthrough
  return { ...inputData, actionExecuted: node.parameters.action ?? 'unknown' };
});

registerNodeHandler('error_handler', async (_node, inputData) => {
  return { ...inputData, errorHandled: true };
});

registerNodeHandler('approval', async (node, inputData) => {
  // Approval nodes pause execution — in a real implementation this would create
  // an approval request and wait. For now, auto-approve.
  return { ...inputData, approved: true, approvalNode: node.name };
});

// ── Expression evaluator (safe, no eval) ─────────────────────────────────────

function evaluateExpression(expr: string, data: Record<string, unknown>): unknown {
  // Simple dot-path resolver: "input.field.subfield" → data.field.subfield
  if (expr.startsWith('$input.')) {
    const path = expr.slice(7).split('.');
    let current: unknown = data;
    for (const key of path) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current;
  }
  // Boolean literals
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  // String literal
  if (expr.startsWith('"') && expr.endsWith('"')) return expr.slice(1, -1);
  // Number
  const num = Number(expr);
  if (!isNaN(num)) return num;
  // Default: return as string
  return expr;
}

// ── Topological sort ─────────────────────────────────────────────────────────

function topologicalSort(nodes: WorkflowNode[], connections: WorkflowConnection[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const conn of connections) {
    const targets = adjacency.get(conn.fromNodeId) ?? [];
    targets.push(conn.toNodeId);
    adjacency.set(conn.fromNodeId, targets);
    inDegree.set(conn.toNodeId, (inDegree.get(conn.toNodeId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    sorted.push(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(target) ?? 1) - 1;
      inDegree.set(target, newDegree);
      if (newDegree === 0) queue.push(target);
    }
  }

  return sorted;
}

// ── Core execution engine ────────────────────────────────────────────────────

/**
 * Execute a workflow definition. Creates execution + node execution records.
 * Returns the completed WorkflowExecution.
 */
export async function executeWorkflow(
  db: ISqliteDriver,
  workflow: WorkflowDefinition,
  triggerData: Record<string, unknown> = {}
): Promise<WorkflowExecution> {
  const executionId = crypto.randomUUID();
  const now = Date.now();
  const span = startSpan('titanx.workflow', 'workflow.execute', {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    execution_id: executionId,
  });

  // Create execution record
  db.prepare(
    'INSERT INTO workflow_executions (id, workflow_id, status, trigger_data, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(executionId, workflow.id, 'running', JSON.stringify(triggerData), now, now);

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'workflow_engine',
    action: 'workflow.execution_started',
    entityType: 'workflow_execution',
    entityId: executionId,
    details: { workflowId: workflow.id, workflowName: workflow.name },
  });

  const context: ExecutionContext = {
    db,
    executionId,
    workflowId: workflow.id,
    nodeOutputs: new Map(),
    cancelled: false,
  };

  // Set trigger data as output of trigger nodes
  for (const node of workflow.nodes) {
    if (node.type === 'trigger' || node.type === 'webhook') {
      context.nodeOutputs.set(node.id, triggerData);
    }
  }

  let finalStatus: ExecutionStatus = 'completed';
  let finalError: string | undefined;

  try {
    const executionOrder = topologicalSort(workflow.nodes, workflow.connections);
    const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]));

    for (const nodeId of executionOrder) {
      if (context.cancelled) {
        finalStatus = 'cancelled';
        break;
      }

      const node = nodeMap.get(nodeId);
      if (!node) continue;

      // Skip trigger nodes (already processed)
      if (node.type === 'trigger' || node.type === 'webhook') continue;

      await executeNode(db, node, workflow.connections, context);
    }
  } catch (err) {
    finalStatus = 'failed';
    finalError = err instanceof Error ? err.message : String(err);
    span.setStatus('error', finalError);
  }

  // Update execution record
  const finishedAt = Date.now();
  db.prepare('UPDATE workflow_executions SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(
    finalStatus,
    finishedAt,
    finalError ?? null,
    executionId
  );

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'workflow_engine',
    action: `workflow.execution_${finalStatus}`,
    entityType: 'workflow_execution',
    entityId: executionId,
    details: { workflowId: workflow.id, status: finalStatus, durationMs: finishedAt - now },
  });

  getCounter('titanx.workflow', 'titanx.workflow.executions', 'Workflow executions').add(1, {
    status: finalStatus,
    workflow_name: workflow.name,
  });

  span.setStatus(finalStatus === 'completed' ? 'ok' : 'error');
  span.end();

  return {
    id: executionId,
    workflowId: workflow.id,
    status: finalStatus,
    triggerData,
    startedAt: now,
    finishedAt,
    error: finalError,
    createdAt: now,
  };
}

async function executeNode(
  db: ISqliteDriver,
  node: WorkflowNode,
  connections: WorkflowConnection[],
  context: ExecutionContext
): Promise<void> {
  const nodeExecId = crypto.randomUUID();
  const nodeSpan = startSpan('titanx.workflow', `workflow.node.${node.type}`, {
    node_id: node.id,
    node_name: node.name,
    node_type: node.type,
  });

  // Gather input from upstream nodes
  const inputData = gatherInputData(node.id, connections, context);

  // Create node execution record
  db.prepare(
    'INSERT INTO workflow_node_executions (id, execution_id, node_id, node_type, status, input_data, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nodeExecId, context.executionId, node.id, node.type, 'running', JSON.stringify(inputData), Date.now());

  const handler = nodeHandlers.get(node.type);
  if (!handler) {
    updateNodeExecution(db, nodeExecId, 'failed', {}, `No handler for node type: ${node.type}`);
    nodeSpan.setStatus('error', `No handler for ${node.type}`);
    nodeSpan.end();
    if (node.onError === 'stop') throw new Error(`No handler for node type: ${node.type}`);
    return;
  }

  let retries = 0;
  const maxRetries = node.retryConfig?.maxRetries ?? 0;

  while (retries <= maxRetries) {
    try {
      const output = await handler(node, inputData, context);
      context.nodeOutputs.set(node.id, output);
      updateNodeExecution(db, nodeExecId, 'completed', output, undefined, retries);
      nodeSpan.setStatus('ok');
      nodeSpan.end();
      return;
    } catch (err) {
      retries++;
      if (retries > maxRetries) {
        const errMsg = err instanceof Error ? err.message : String(err);
        updateNodeExecution(db, nodeExecId, 'failed', {}, errMsg, retries - 1);
        nodeSpan.setStatus('error', errMsg);
        nodeSpan.end();
        if (node.onError === 'stop') throw err;
        return;
      }
      // Backoff before retry
      const backoff = node.retryConfig?.backoffMs ?? 1000;
      await new Promise((r) => setTimeout(r, backoff * retries));
    }
  }
}

function gatherInputData(
  nodeId: string,
  connections: WorkflowConnection[],
  context: ExecutionContext
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  const incomingConnections = connections.filter((c) => c.toNodeId === nodeId);

  for (const conn of incomingConnections) {
    const upstream = context.nodeOutputs.get(conn.fromNodeId);
    if (upstream) {
      Object.assign(inputs, upstream);
    }
  }

  return inputs;
}

function updateNodeExecution(
  db: ISqliteDriver,
  nodeExecId: string,
  status: NodeExecutionStatus,
  outputData: Record<string, unknown>,
  error?: string,
  retryCount?: number
): void {
  db.prepare(
    'UPDATE workflow_node_executions SET status = ?, output_data = ?, error = ?, retry_count = ?, finished_at = ? WHERE id = ?'
  ).run(status, JSON.stringify(outputData), error ?? null, retryCount ?? 0, Date.now(), nodeExecId);
}

// ── Query functions ──────────────────────────────────────────────────────────

export function getExecution(db: ISqliteDriver, executionId: string): WorkflowExecution | null {
  const row = db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToExecution(row) : null;
}

export function listExecutions(db: ISqliteDriver, workflowId?: string, limit = 50): WorkflowExecution[] {
  const rows = workflowId
    ? (db
        .prepare('SELECT * FROM workflow_executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(workflowId, limit) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM workflow_executions ORDER BY started_at DESC LIMIT ?').all(limit) as Array<
        Record<string, unknown>
      >);
  return rows.map(rowToExecution);
}

export function getNodeExecutions(db: ISqliteDriver, executionId: string): NodeExecution[] {
  const rows = db
    .prepare('SELECT * FROM workflow_node_executions WHERE execution_id = ? ORDER BY started_at ASC')
    .all(executionId) as Array<Record<string, unknown>>;
  return rows.map(rowToNodeExecution);
}

function rowToExecution(row: Record<string, unknown>): WorkflowExecution {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    status: row.status as ExecutionStatus,
    triggerData: JSON.parse((row.trigger_data as string) || '{}'),
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number) ?? undefined,
    error: (row.error as string) ?? undefined,
    createdAt: row.created_at as number,
  };
}

function rowToNodeExecution(row: Record<string, unknown>): NodeExecution {
  return {
    id: row.id as string,
    executionId: row.execution_id as string,
    nodeId: row.node_id as string,
    nodeType: row.node_type as string,
    status: row.status as NodeExecutionStatus,
    inputData: JSON.parse((row.input_data as string) || '{}'),
    outputData: JSON.parse((row.output_data as string) || '{}'),
    error: (row.error as string) ?? undefined,
    retryCount: (row.retry_count as number) ?? 0,
    startedAt: (row.started_at as number) ?? undefined,
    finishedAt: (row.finished_at as number) ?? undefined,
  };
}
