/**
 * @license Apache-2.0
 * Behavior lock-in tests for WakeState.
 *
 * WakeState is the pure-bookkeeping half of TeammateManager's wake system
 * (the async side-effects — reading mailbox, building payloads, sending
 * messages — stay in TeammateManager.wake() until a later pass). This class
 * owns:
 *   - `activeWakes`: which slotIds are currently mid-turn
 *   - `pendingWakes`: wakes that arrived while an agent was busy
 *   - `wakeTimeouts`: the 60s "force-release if turnCompleted never fires" watchdog
 *
 * These tests codify the semantics already implemented in TeammateManager
 * so the extraction can be verified as a mechanical rearrangement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WakeState } from '@process/team/WakeState';

describe('WakeState', () => {
  let state: WakeState;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new WakeState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('active wakes', () => {
    it('tracks which slots are actively being woken', () => {
      state.markActive('slot-a');
      expect(state.isActive('slot-a')).toBe(true);
      expect(state.isActive('slot-b')).toBe(false);
    });

    it('releaseActive drops the active flag', () => {
      state.markActive('slot-a');
      state.releaseActive('slot-a');
      expect(state.isActive('slot-a')).toBe(false);
    });

    it('activeConversationIds() returns converted conversation IDs from active slots', () => {
      state.markActive('slot-a');
      state.markActive('slot-b');
      const convs = state.activeConversationIds(
        new Map([
          ['slot-a', 'conv-a'],
          ['slot-b', 'conv-b'],
          ['slot-c', 'conv-c'],
        ])
      );
      expect(convs).toEqual(new Set(['conv-a', 'conv-b']));
    });
  });

  describe('pending wake queue', () => {
    it('queueing while active returns true; queueing without active returns false', () => {
      state.markActive('slot-a');
      expect(state.queueIfActive('slot-a')).toBe(true);
      expect(state.hasPending('slot-a')).toBe(true);
    });

    it('queueing an idle slot does not add to the queue', () => {
      expect(state.queueIfActive('slot-a')).toBe(false);
      expect(state.hasPending('slot-a')).toBe(false);
    });

    it('dequeuePending removes and returns whether anything was there', () => {
      state.markActive('slot-a');
      state.queueIfActive('slot-a');
      expect(state.dequeuePending('slot-a')).toBe(true);
      expect(state.hasPending('slot-a')).toBe(false);
      expect(state.dequeuePending('slot-a')).toBe(false);
    });

    it('sweepStaleRetries removes keys with the retry_ prefix', () => {
      state.markActive('slot-a');
      state.queueIfActive('slot-a');
      state.addPending('retry_slot-a');
      state.addPending('retry_slot-b');
      state.sweepStaleRetries();
      expect(state.hasPending('slot-a')).toBe(true); // legitimate queue entry preserved
      expect(state.hasPending('retry_slot-a')).toBe(false);
      expect(state.hasPending('retry_slot-b')).toBe(false);
    });
  });

  describe('wake timeouts', () => {
    it('scheduleTimeout fires the handler after the given delay', () => {
      const handler = vi.fn();
      state.scheduleTimeout('slot-a', 1000, handler);
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(handler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('clearTimeout prevents the handler from firing', () => {
      const handler = vi.fn();
      state.scheduleTimeout('slot-a', 1000, handler);
      state.clearTimeout('slot-a');
      vi.advanceTimersByTime(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('re-scheduling cancels the previous timer for the same slot', () => {
      const first = vi.fn();
      const second = vi.fn();
      state.scheduleTimeout('slot-a', 1000, first);
      state.scheduleTimeout('slot-a', 500, second);
      vi.advanceTimersByTime(2000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it('sweepOrphanedTimeouts cancels timeouts whose slot is no longer active', () => {
      const a = vi.fn();
      const b = vi.fn();
      state.markActive('slot-a');
      // slot-b is NOT marked active
      state.scheduleTimeout('slot-a', 1000, a);
      state.scheduleTimeout('slot-b', 1000, b);
      state.sweepOrphanedTimeouts();
      vi.advanceTimersByTime(2000);
      expect(a).toHaveBeenCalledOnce();
      expect(b).not.toHaveBeenCalled(); // orphan cancelled
    });
  });

  describe('dispose', () => {
    it('clears every in-flight timeout, active slot, and pending entry', () => {
      const h = vi.fn();
      state.markActive('slot-a');
      state.queueIfActive('slot-a');
      state.scheduleTimeout('slot-a', 1000, h);
      state.dispose();
      expect(state.isActive('slot-a')).toBe(false);
      expect(state.hasPending('slot-a')).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(h).not.toHaveBeenCalled();
    });
  });
});
