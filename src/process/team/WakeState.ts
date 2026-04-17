/**
 * @license Apache-2.0
 * WakeState — bookkeeping for the teammate wake lifecycle.
 *
 * Extracted from TeammateManager (Phase 3.2) to isolate the pure state half
 * of the wake system. This class owns NO async side effects — the orchestration
 * (reading mailbox, building payloads, sending messages) stays in
 * TeammateManager.wake() for now. What moves here:
 *
 *   - activeWakes         — which slots are currently mid-turn (guards against re-entry)
 *   - pendingWakes        — wakes queued while an agent was busy
 *   - wakeTimeouts        — the per-slot watchdog that force-releases a stuck wake
 *
 * The result: TeammateManager's wake() stops touching three private Sets/Maps
 * directly and instead calls `markActive / queueIfActive / scheduleTimeout /
 * releaseActive / clearTimeout`. Makes the lifecycle easy to test in isolation
 * (see tests/unit/WakeState.test.ts) and sets up the next extraction pass to
 * relocate wake() itself into a full WakeCoordinator class.
 */

export class WakeState {
  private readonly active = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  // ── Active wakes ─────────────────────────────────────────────────────────

  markActive(slotId: string): void {
    this.active.add(slotId);
  }

  releaseActive(slotId: string): void {
    this.active.delete(slotId);
  }

  isActive(slotId: string): boolean {
    return this.active.has(slotId);
  }

  /**
   * Convert the active slot set to the corresponding conversation-ID set.
   * Used by the memory sweeper to decide which response buffers are stale.
   */
  activeConversationIds(slotToConv: ReadonlyMap<string, string>): Set<string> {
    const result = new Set<string>();
    for (const slotId of this.active) {
      const convId = slotToConv.get(slotId);
      if (convId) result.add(convId);
    }
    return result;
  }

  /** Iterate active slots (primarily for dispose/debug). */
  activeSlots(): ReadonlySet<string> {
    return this.active;
  }

  // ── Pending wake queue ───────────────────────────────────────────────────

  /**
   * If the given slot is currently mid-turn, queue the wake for later and
   * return true. If the slot is not active, do nothing and return false —
   * callers interpret this as "you can proceed to wake normally".
   */
  queueIfActive(slotId: string): boolean {
    if (!this.active.has(slotId)) return false;
    this.pending.add(slotId);
    return true;
  }

  /** Force-add a pending entry (used for retry_<slotId> keys). */
  addPending(key: string): void {
    this.pending.add(key);
  }

  hasPending(key: string): boolean {
    return this.pending.has(key);
  }

  /** Remove a pending entry. Returns whether it existed. */
  dequeuePending(key: string): boolean {
    return this.pending.delete(key);
  }

  /**
   * Drop every retry_<slotId> entry from the pending queue. Mirrors the sweep
   * in TeammateManager.sweepMemory() — retries that haven't fired within the
   * expected window are considered leaked.
   */
  sweepStaleRetries(): void {
    for (const key of this.pending) {
      if (key.startsWith('retry_')) this.pending.delete(key);
    }
  }

  // ── Wake timeouts ───────────────────────────────────────────────────────

  /**
   * Schedule a per-slot watchdog timer. If another timer is already set for
   * this slot, it is cleared first so we never have two concurrent watchdogs
   * racing.
   */
  scheduleTimeout(slotId: string, delayMs: number, handler: () => void): void {
    const existing = this.timeouts.get(slotId);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.timeouts.delete(slotId);
      handler();
    }, delayMs);
    this.timeouts.set(slotId, handle);
  }

  /** Cancel the watchdog for a slot, if any. */
  clearTimeout(slotId: string): void {
    const handle = this.timeouts.get(slotId);
    if (handle) {
      clearTimeout(handle);
      this.timeouts.delete(slotId);
    }
  }

  /**
   * Cancel every watchdog whose slot is no longer in the active set.
   * Called from the periodic memory sweeper.
   */
  sweepOrphanedTimeouts(): void {
    for (const [slotId, handle] of this.timeouts) {
      if (!this.active.has(slotId)) {
        clearTimeout(handle);
        this.timeouts.delete(slotId);
      }
    }
  }

  // ── Dispose ─────────────────────────────────────────────────────────────

  dispose(): void {
    for (const handle of this.timeouts.values()) clearTimeout(handle);
    this.timeouts.clear();
    this.active.clear();
    this.pending.clear();
  }
}
