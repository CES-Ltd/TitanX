/**
 * @license Apache-2.0
 * Agent Workflow Builder — per-slot in-flight dispatch guard.
 *
 * Prevents double-dispatch of a workflow step for the same agent slot
 * while a turn is already in flight. Clone of the CronBusyGuard shape
 * (src/process/services/cron/CronBusyGuard.ts) — same per-key
 * in-memory state map, same `onceIdle` callback plumbing, same
 * periodic cleanup — but keyed on `agent_slot_id` instead of
 * `conversation_id`, because a single conversation can host multiple
 * agent slots each running its own workflow binding.
 *
 * Lifecycle:
 *
 *   - dispatcher calls `setDispatching(slotId, true)` immediately
 *     before it advances a step
 *   - dispatcher calls `setDispatching(slotId, false)` once the
 *     step handler has returned (success, failure, or retry exhausted)
 *   - between those two calls, any concurrent dispatch attempt for
 *     the same slot is a no-op (or can `onceIdle`-queue if it needs
 *     to run eventually)
 *
 * This is an in-memory advisory lock — the map is empty on app
 * relaunch, which is the correct behavior (no turn can be "in
 * flight" across an app restart; the `agent_workflow_runs` table is
 * the source of truth for persistent state).
 *
 * Exported as a singleton (`agentWorkflowBusyGuard`) so the
 * dispatcher and debug viewer see the same lock state. Auto-cleanup
 * is wired at app boot from the main process (see
 * `initStorage.ts` — called alongside `cronBusyGuard.startAutoCleanup()`).
 */

type SlotDispatchState = {
  isDispatching: boolean;
  lastActiveAt: number;
};

type IdleCallback = () => void;

export class AgentWorkflowBusyGuard {
  private states = new Map<string, SlotDispatchState>();
  private idleCallbacks = new Map<string, IdleCallback[]>();
  private autoCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** True if a step is currently being dispatched for this slot. */
  isDispatching(slotId: string): boolean {
    return this.states.get(slotId)?.isDispatching ?? false;
  }

  /**
   * Set the dispatch-in-flight flag. Call with `true` immediately
   * before advancing a step, and `false` once the handler has
   * settled. Firing the `false` call also flushes any callbacks that
   * were queued via `onceIdle` while the slot was busy.
   */
  setDispatching(slotId: string, value: boolean): void {
    const state = this.states.get(slotId) ?? { isDispatching: false, lastActiveAt: 0 };
    state.isDispatching = value;
    if (value) state.lastActiveAt = Date.now();
    this.states.set(slotId, state);

    if (!value) {
      const callbacks = this.idleCallbacks.get(slotId);
      if (callbacks) {
        this.idleCallbacks.delete(slotId);
        for (const cb of callbacks) cb();
      }
    }
  }

  /**
   * Register a one-shot callback for when the slot next goes idle.
   * Fires immediately if the slot is already idle. Useful for the
   * dispatcher to queue a follow-up step behind a step that's
   * already in flight.
   */
  onceIdle(slotId: string, callback: IdleCallback): void {
    if (!this.isDispatching(slotId)) {
      callback();
      return;
    }
    const existing = this.idleCallbacks.get(slotId) ?? [];
    existing.push(callback);
    this.idleCallbacks.set(slotId, existing);
  }

  getLastActiveAt(slotId: string): number | undefined {
    return this.states.get(slotId)?.lastActiveAt;
  }

  /**
   * Poll until the slot is idle or timeout fires. Used by tests and
   * by the dispatcher's "wait for in-flight then abort" path. Uses a
   * short (250ms) poll because per-step dispatch is generally
   * sub-second; no callers need a longer interval.
   */
  async waitForIdle(slotId: string, timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    const pollInterval = 250;
    while (this.isDispatching(slotId)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timeout waiting for slot ${slotId} workflow dispatch to complete`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * Sweep stale idle entries. Default horizon is 1 hour, mirroring
   * CronBusyGuard.cleanup — a slot that hasn't dispatched for an
   * hour almost certainly has no pending follow-up.
   */
  cleanup(olderThanMs = 3600000): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (!state.isDispatching && now - state.lastActiveAt > olderThanMs) {
        this.states.delete(id);
      }
    }
  }

  /** Remove state for a specific slot. Call when a slot is deleted. */
  remove(slotId: string): void {
    this.states.delete(slotId);
    this.idleCallbacks.delete(slotId);
  }

  /** Clear all state. Tests only. */
  clear(): void {
    this.states.clear();
    this.idleCallbacks.clear();
  }

  /** Snapshot of all slot states. Debug viewer only. */
  getAllStates(): Map<string, SlotDispatchState> {
    return new Map(this.states);
  }

  /**
   * Idempotent via the existing-timer guard. Caller (main process
   * boot) must pair with `stopAutoCleanup()` at app shutdown so the
   * timer doesn't block process exit.
   */
  startAutoCleanup(intervalMs = 60 * 60 * 1000): void {
    if (this.autoCleanupTimer) return;
    this.autoCleanupTimer = setInterval(() => this.cleanup(), intervalMs);
  }

  stopAutoCleanup(): void {
    if (this.autoCleanupTimer) {
      clearInterval(this.autoCleanupTimer);
      this.autoCleanupTimer = null;
    }
  }
}

/** Singleton — the dispatcher, debug viewer, and tests share this instance. */
export const agentWorkflowBusyGuard = new AgentWorkflowBusyGuard();
