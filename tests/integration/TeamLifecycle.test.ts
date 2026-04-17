/**
 * @license Apache-2.0
 * Integration test for the team wake → turn → finalize → release lifecycle.
 *
 * Unit tests cover each collaborator in isolation (ResponseStreamBuffer,
 * WakeState, IEventPublisher, TaskManager). This test composes them through
 * the same sequence TeammateManager orchestrates in production and asserts
 * end-state invariants:
 *   - buffers empty after finalize
 *   - active flag released
 *   - no orphan watchdog timers
 *   - finalized-turn dedup works across overlapping wakes
 *
 * Uses real implementations of the extracted collaborators + a capturing
 * IEventPublisher stub. No Electron, no SQLite, no IPC — just the pieces
 * that the god-object split produced, wired together.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ResponseStreamBuffer } from '@process/team/ResponseStreamBuffer';
import { WakeState } from '@process/team/WakeState';
import type { IEventPublisher, TeamEventMap, TeamEventName } from '@process/team/ports/IEventPublisher';

/** Capturing publisher — records every event so assertions can inspect order + payload. */
function makeCapturingPublisher(): {
  publisher: IEventPublisher;
  events: Array<{ name: TeamEventName; payload: unknown }>;
} {
  const events: Array<{ name: TeamEventName; payload: unknown }> = [];
  const publisher: IEventPublisher = {
    emit<K extends TeamEventName>(name: K, payload: TeamEventMap[K]): void {
      events.push({ name, payload });
    },
  };
  return { publisher, events };
}

describe('Team lifecycle integration', () => {
  let buffer: ResponseStreamBuffer;
  let wake: WakeState;
  let publisher: IEventPublisher;
  let events: Array<{ name: TeamEventName; payload: unknown }>;
  const TEAM = 'team-int';
  const SLOT = 'slot-alpha';
  const CONV = 'conv-alpha';

  beforeEach(() => {
    vi.useFakeTimers();
    buffer = new ResponseStreamBuffer();
    wake = new WakeState();
    const pub = makeCapturingPublisher();
    publisher = pub.publisher;
    events = pub.events;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Simulates the inside of TeammateManager.wake() → handleResponseStream() →
   * finalizeTurn() sequence, using only the extracted collaborators.
   */
  function simulateTurn(
    slotId: string,
    convId: string,
    chunks: unknown[],
    opts: { releaseOnFinalize?: boolean } = { releaseOnFinalize: true }
  ): string {
    // wake() start
    wake.markActive(slotId);
    buffer.resetFor(convId);
    publisher.emit('team.agent-status-changed', { teamId: TEAM, slotId, status: 'active' });
    wake.scheduleTimeout(slotId, 60_000, () => {
      publisher.emit('team.agent-status-changed', { teamId: TEAM, slotId, status: 'idle', lastMessage: 'timeout' });
      wake.releaseActive(slotId);
    });

    // Streaming content arrives
    for (const chunk of chunks) {
      buffer.appendNormalized(convId, chunk);
      publisher.emit('team.message-stream', {
        teamId: TEAM,
        slotId,
        type: 'content',
        data: chunk,
        msg_id: 'm',
        conversation_id: convId,
      });
    }

    // finalizeTurn()
    if (buffer.isFinalized(convId)) return '';
    buffer.markFinalized(convId);
    setTimeout(() => buffer.unmarkFinalized(convId), 5000);
    const accumulated = buffer.take(convId);
    if (opts.releaseOnFinalize) {
      wake.releaseActive(slotId);
      wake.clearTimeout(slotId);
    }
    publisher.emit('team.agent-status-changed', { teamId: TEAM, slotId, status: 'idle' });
    return accumulated;
  }

  describe('single turn', () => {
    it('accumulates streamed chunks, publishes events in order, ends with clean state', () => {
      const result = simulateTurn(SLOT, CONV, ['Hello ', { text: 'world' }, { content: '!' }]);

      // Accumulated text joins all three chunk shapes
      expect(result).toBe('Hello world!');

      // Events: status→active, 3x message-stream, status→idle
      expect(events.map((e) => e.name)).toEqual([
        'team.agent-status-changed',
        'team.message-stream',
        'team.message-stream',
        'team.message-stream',
        'team.agent-status-changed',
      ]);
      expect((events[0].payload as { status: string }).status).toBe('active');
      expect((events[4].payload as { status: string }).status).toBe('idle');

      // Buffer empty post-finalize
      expect(buffer.peek(CONV)).toBe('');

      // Active flag released
      expect(wake.isActive(SLOT)).toBe(false);

      // No watchdog should fire because we cleared it on finalize
      vi.advanceTimersByTime(61_000);
      // Only the 5s finalized-turn self-clear should remain; no extra status events
      expect(events.filter((e) => e.name === 'team.agent-status-changed')).toHaveLength(2);
    });

    it('finalized-turn dedup prevents double processing', () => {
      const first = simulateTurn(SLOT, CONV, ['first'], { releaseOnFinalize: false });
      expect(first).toBe('first');
      // Second finalize attempt returns '' (dedup via markFinalized guard)
      const second = simulateTurn(SLOT, CONV, ['second'], { releaseOnFinalize: true });
      expect(second).toBe('');
    });

    it('self-clearing finalized mark restores after 5s so future turns work', () => {
      simulateTurn(SLOT, CONV, ['turn-1']);
      vi.advanceTimersByTime(5_000);
      expect(buffer.isFinalized(CONV)).toBe(false);
      const result = simulateTurn(SLOT, CONV, ['turn-2']);
      expect(result).toBe('turn-2');
    });
  });

  describe('concurrent wake attempts', () => {
    it('queueing while active, then dequeueing after finalize', () => {
      wake.markActive(SLOT);
      // Second wake attempt while busy → queued
      const queued = wake.queueIfActive(SLOT);
      expect(queued).toBe(true);
      expect(wake.hasPending(SLOT)).toBe(true);
      // Release (simulating finalize) + dequeue
      wake.releaseActive(SLOT);
      expect(wake.dequeuePending(SLOT)).toBe(true);
      expect(wake.hasPending(SLOT)).toBe(false);
    });
  });

  describe('watchdog timeout', () => {
    it('fires the timeout handler when finalize never happens', () => {
      wake.markActive(SLOT);
      buffer.resetFor(CONV);
      buffer.append(CONV, 'stuck');
      const timeoutFired = vi.fn();
      wake.scheduleTimeout(SLOT, 60_000, () => {
        timeoutFired();
        wake.releaseActive(SLOT);
      });
      // Never call finalize — just advance the clock
      vi.advanceTimersByTime(60_000);
      expect(timeoutFired).toHaveBeenCalledOnce();
      expect(wake.isActive(SLOT)).toBe(false);
      // Buffer still holds the stuck text until swept
      expect(buffer.peek(CONV)).toBe('stuck');
    });

    it('sweep drops buffers whose slot is no longer active', () => {
      wake.markActive(SLOT);
      buffer.append(CONV, 'alive');
      buffer.append('conv-stale', 'dead');
      // Only SLOT is active; conv-stale's slot is NOT active
      const slotToConv = new Map([
        [SLOT, CONV],
        ['slot-stale', 'conv-stale'],
      ]);
      buffer.sweep(wake.activeConversationIds(slotToConv));
      expect(buffer.peek(CONV)).toBe('alive');
      expect(buffer.peek('conv-stale')).toBe('');
    });
  });

  describe('retry flow', () => {
    it('retry_<slot> keys in the queue are swept after the configured window', () => {
      wake.addPending(`retry_${SLOT}`);
      wake.addPending(`retry_slot-beta`);
      expect(wake.hasPending(`retry_${SLOT}`)).toBe(true);
      wake.sweepStaleRetries();
      expect(wake.hasPending(`retry_${SLOT}`)).toBe(false);
      expect(wake.hasPending(`retry_slot-beta`)).toBe(false);
    });
  });

  describe('dispose', () => {
    it('clears all state — post-dispose a new turn starts clean', () => {
      wake.markActive(SLOT);
      wake.queueIfActive(SLOT);
      buffer.append(CONV, 'stale');
      buffer.markFinalized(CONV);
      const handler = vi.fn();
      wake.scheduleTimeout(SLOT, 1000, handler);

      wake.dispose();
      buffer.clearFinalizedExpired();
      buffer.clear(CONV);

      expect(wake.isActive(SLOT)).toBe(false);
      expect(wake.hasPending(SLOT)).toBe(false);
      expect(buffer.peek(CONV)).toBe('');
      expect(buffer.isFinalized(CONV)).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
