/**
 * @license Apache-2.0
 * Workflow engine types — n8n-inspired DAG workflow definitions.
 */

/** Node types available in the workflow editor */
export type WorkflowNodeType =
  | 'trigger'
  | 'action'
  | 'condition'
  | 'loop'
  | 'error_handler'
  | 'webhook'
  | 'agent_call'
  | 'transform'
  | 'approval'
  | 'security_check'
  | 'memory'
  | 'planning'
  | 'reflection_gate';

/** A single node in the workflow DAG */
export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  name: string;
  parameters: Record<string, unknown>;
  position: { x: number; y: number };
  retryConfig?: { maxRetries: number; backoffMs: number };
  errorWorkflowId?: string;
  onError: 'stop' | 'continue' | 'retry';
};

/** A connection between two nodes */
export type WorkflowConnection = {
  fromNodeId: string;
  fromOutput: string;
  toNodeId: string;
  toInput: string;
};

/** A complete workflow definition */
export type WorkflowDefinition = {
  id: string;
  userId: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  settings: Record<string, unknown>;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
};

/** Execution status */
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type NodeExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** A workflow execution record */
export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  triggerData: Record<string, unknown>;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  createdAt: number;
};

/** A node execution record within a workflow execution */
export type NodeExecution = {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: string;
  status: NodeExecutionStatus;
  inputData: Record<string, unknown>;
  outputData: Record<string, unknown>;
  error?: string;
  retryCount: number;
  startedAt?: number;
  finishedAt?: number;
};

/** Input for creating a workflow */
export type CreateWorkflowInput = {
  userId: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  settings?: Record<string, unknown>;
};
