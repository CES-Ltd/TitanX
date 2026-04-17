/**
 * @license Apache-2.0
 * Tests for the logNonCritical observability helper.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  logNonCritical,
  getNonCriticalFailureCounts,
  _resetNonCriticalLogForTests,
} from '@process/utils/logNonCritical';

describe('logNonCritical', () => {
  beforeEach(() => {
    _resetNonCriticalLogForTests();
    vi.restoreAllMocks();
  });

  it('counts failures by context label', () => {
    logNonCritical('audit', new Error('boom'));
    logNonCritical('audit', new Error('boom'));
    logNonCritical('telemetry', new Error('different'));

    const counts = getNonCriticalFailureCounts();
    expect(counts.audit).toBe(2);
    expect(counts.telemetry).toBe(1);
  });

  it('emits a console.warn on the first occurrence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logNonCritical('ctx', new Error('first'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[non-critical:ctx]');
    expect(warn.mock.calls[0][0]).toContain('first');
  });

  it('dedupes repeated identical messages (no spam)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 50; i++) {
      logNonCritical('ctx', new Error('same'));
    }
    // First occurrence logs; subsequent identical ones suppressed until count hits 100.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getNonCriticalFailureCounts().ctx).toBe(50);
  });

  it('logs again when the error message changes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logNonCritical('ctx', new Error('a'));
    logNonCritical('ctx', new Error('a'));
    logNonCritical('ctx', new Error('b'));
    logNonCritical('ctx', new Error('b'));
    // a (1st), b (2nd distinct) → 2 log calls
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs every 100 occurrences even with repeated messages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 200; i++) {
      logNonCritical('ctx', new Error('same'));
    }
    // 1st + 100th + 200th = 3 logs
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('coerces non-Error values to strings without crashing', () => {
    expect(() => logNonCritical('ctx', 'plain string')).not.toThrow();
    expect(() => logNonCritical('ctx', { custom: 'object' })).not.toThrow();
    expect(() => logNonCritical('ctx', null)).not.toThrow();
    expect(() => logNonCritical('ctx', undefined)).not.toThrow();
    expect(getNonCriticalFailureCounts().ctx).toBe(4);
  });

  it('returns a snapshot — mutations do not affect internal state', () => {
    logNonCritical('ctx', new Error('x'));
    const snapshot = getNonCriticalFailureCounts();
    snapshot.ctx = 999;
    const again = getNonCriticalFailureCounts();
    expect(again.ctx).toBe(1);
  });
});
