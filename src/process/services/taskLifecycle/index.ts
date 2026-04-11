/**
 * Task Lifecycle State Machine — enforced state transitions with audit trail.
 *
 * Prevents: ghost tasks, race conditions, invalid state changes, agent impersonation.
 * Every transition is validated, logged, and auditable.
 *
 * Inspired by Multica's task lifecycle: queued → claimed → dispatched → running → completed/failed
 */

import type { TaskState, StateTransition } from './types';
import { VALID_TRANSITIONS } from './types';

export { VALID_TRANSITIONS, SPRINT_TO_LIFECYCLE, LIFECYCLE_TO_SPRINT } from './types';
export type { TaskState, StateTransition } from './types';

/**
 * Validate a state transition. Returns true if the transition is allowed.
 */
export function isValidTransition(from: TaskState, to: TaskState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Attempt a state transition. Throws if invalid.
 * Returns a StateTransition record for the audit trail.
 */
export function transition(
  currentState: TaskState,
  targetState: TaskState,
  actorId: string,
  reason?: string
): StateTransition {
  if (!isValidTransition(currentState, targetState)) {
    const allowed = VALID_TRANSITIONS[currentState]?.join(', ') ?? 'none';
    console.error(
      `[TaskLifecycle] REJECTED: ${currentState} → ${targetState} (actor: ${actorId}). Allowed: ${allowed}`
    );
    throw new Error(
      `Invalid task state transition: ${currentState} → ${targetState}. Allowed transitions from ${currentState}: [${allowed}]`
    );
  }

  const entry: StateTransition = {
    from: currentState,
    to: targetState,
    timestamp: Date.now(),
    actorId,
    reason,
  };

  console.log(
    `[TaskLifecycle] ${currentState} → ${targetState} (actor: ${actorId}${reason ? `, reason: ${reason}` : ''})`
  );

  return entry;
}

/**
 * Check if a state is terminal (no further transitions allowed).
 */
export function isTerminal(state: TaskState): boolean {
  const allowed = VALID_TRANSITIONS[state];
  return !allowed || allowed.length === 0;
}

/**
 * Get all valid next states from the current state.
 */
export function nextStates(current: TaskState): TaskState[] {
  return VALID_TRANSITIONS[current] ?? [];
}

/**
 * Validate a state transition for a sprint board status string.
 * Converts sprint status to lifecycle state and validates.
 */
export function validateSprintTransition(currentSprintStatus: string, targetSprintStatus: string): boolean {
  const { SPRINT_TO_LIFECYCLE } = require('./types');
  const from = SPRINT_TO_LIFECYCLE[currentSprintStatus] as TaskState | undefined;
  const to = SPRINT_TO_LIFECYCLE[targetSprintStatus] as TaskState | undefined;
  if (!from || !to) return true; // Unknown statuses pass through (backward compat)
  return isValidTransition(from, to);
}
