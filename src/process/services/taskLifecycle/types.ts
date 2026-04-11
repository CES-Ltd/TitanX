/**
 * Task Lifecycle State Machine — types and transition rules.
 * Inspired by Multica's task state machine: prevents ghost tasks, race conditions,
 * and invalid state transitions.
 */

/** All valid task states in the lifecycle. */
export type TaskState = 'queued' | 'claimed' | 'dispatched' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Valid state transitions. Key = current state, value = allowed next states. */
export const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['dispatched', 'cancelled', 'queued'], // can release back to queue
  dispatched: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [], // terminal state
  failed: ['queued'], // can retry by re-queuing
  cancelled: [], // terminal state
};

/** State history entry for audit trail. */
export type StateTransition = {
  from: TaskState;
  to: TaskState;
  timestamp: number;
  actorId: string;
  reason?: string;
};

/** Map sprint board statuses to task lifecycle states. */
export const SPRINT_TO_LIFECYCLE: Record<string, TaskState> = {
  backlog: 'queued',
  todo: 'claimed',
  in_progress: 'running',
  review: 'running',
  done: 'completed',
};

/** Map task lifecycle states to sprint board statuses. */
export const LIFECYCLE_TO_SPRINT: Record<TaskState, string> = {
  queued: 'backlog',
  claimed: 'todo',
  dispatched: 'todo',
  running: 'in_progress',
  completed: 'done',
  failed: 'backlog',
  cancelled: 'done',
};
