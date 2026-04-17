/**
 * @license Apache-2.0
 * Behavior lock-in tests for ResponseStreamBuffer.
 *
 * These tests codify the exact semantics currently implemented inline in
 * TeammateManager.handleResponseStream() + finalizeTurn() so the Phase 3.2
 * extraction can be verified as a mechanical rearrangement with no behavior
 * change. Each test describes an invariant of the existing code, not a new
 * proposed behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseStreamBuffer } from '@process/team/ResponseStreamBuffer';

describe('ResponseStreamBuffer', () => {
  let buf: ResponseStreamBuffer;
  beforeEach(() => {
    buf = new ResponseStreamBuffer();
  });

  describe('append / take', () => {
    it('appends plain string payloads in order', () => {
      buf.append('conv-1', 'Hello ');
      buf.append('conv-1', 'world');
      expect(buf.take('conv-1')).toBe('Hello world');
    });

    it('unwraps { text: string } payload shape', () => {
      buf.appendNormalized('conv-1', { text: 'nested' });
      expect(buf.take('conv-1')).toBe('nested');
    });

    it('unwraps { content: string } payload shape', () => {
      buf.appendNormalized('conv-1', { content: 'wrapped' });
      expect(buf.take('conv-1')).toBe('wrapped');
    });

    it('ignores payloads that are not a recognized shape', () => {
      buf.appendNormalized('conv-1', null);
      buf.appendNormalized('conv-1', 42);
      buf.appendNormalized('conv-1', { other: 'x' });
      expect(buf.take('conv-1')).toBe('');
    });

    it('ignores empty strings (matches current TeammateManager guard)', () => {
      buf.append('conv-1', '');
      expect(buf.take('conv-1')).toBe('');
    });

    it('keeps separate buffers per conversationId', () => {
      buf.append('a', 'hello');
      buf.append('b', 'world');
      expect(buf.take('a')).toBe('hello');
      expect(buf.take('b')).toBe('world');
    });

    it('take() is destructive — calling it twice returns empty the second time', () => {
      buf.append('a', 'xyz');
      expect(buf.take('a')).toBe('xyz');
      expect(buf.take('a')).toBe('');
    });
  });

  describe('reset', () => {
    it('clear() drops a single conversation buffer', () => {
      buf.append('a', 'x');
      buf.append('b', 'y');
      buf.clear('a');
      expect(buf.take('a')).toBe('');
      expect(buf.take('b')).toBe('y');
    });

    it('resetFor(convId) starts a fresh buffer for that conversation', () => {
      buf.append('a', 'stale');
      buf.resetFor('a');
      expect(buf.take('a')).toBe('');
      buf.append('a', 'fresh');
      expect(buf.take('a')).toBe('fresh');
    });
  });

  describe('size cap + truncation', () => {
    it('keeps accumulated text below the configured max bytes (safety net)', () => {
      const small = new ResponseStreamBuffer({ maxBytes: 64 });
      // Append 200 chars in chunks — expect result to be truncated to <= maxBytes
      for (let i = 0; i < 20; i++) small.append('a', '0123456789');
      const taken = small.take('a');
      expect(taken.length).toBeLessThanOrEqual(64);
    });

    it('truncation drops the oldest content — keeps the tail', () => {
      const small = new ResponseStreamBuffer({ maxBytes: 16 });
      small.append('a', 'AAAAAAAA'); // 8
      small.append('a', 'BBBBBBBB'); // 16
      small.append('a', 'CCCCCCCC'); // would exceed — oldest chars dropped
      const taken = small.take('a');
      expect(taken.length).toBeLessThanOrEqual(16);
      expect(taken.endsWith('CCCCCCCC')).toBe(true);
    });
  });

  describe('finalizedTurns set', () => {
    it('markFinalized/isFinalized round-trip', () => {
      expect(buf.isFinalized('a')).toBe(false);
      buf.markFinalized('a');
      expect(buf.isFinalized('a')).toBe(true);
    });

    it('clearFinalizedExpired() empties the entire set (matches current sweep)', () => {
      buf.markFinalized('a');
      buf.markFinalized('b');
      buf.clearFinalizedExpired();
      expect(buf.isFinalized('a')).toBe(false);
      expect(buf.isFinalized('b')).toBe(false);
    });
  });

  describe('sweep', () => {
    it('sweep() drops buffers for conversations whose agent is not currently active', () => {
      buf.append('conv-stale', 'leftover');
      buf.append('conv-active', 'live');
      const activeConvIds = new Set(['conv-active']);
      buf.sweep(activeConvIds);
      expect(buf.take('conv-stale')).toBe('');
      expect(buf.take('conv-active')).toBe('live');
    });
  });
});
