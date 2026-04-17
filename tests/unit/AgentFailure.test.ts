/**
 * @license Apache-2.0
 * Tests for the AgentFailure discriminated union + constructors.
 */

import { describe, it, expect } from 'vitest';
import {
  timeout,
  parsingError,
  apiError,
  policyViolation,
  impersonation,
  wakeDeadlocked,
  internalError,
  fromUnknown,
  isRetryable,
} from '@/common/types/errors';

describe('AgentFailure constructors', () => {
  it('timeout() builds a retryable failure', () => {
    const f = timeout('wake never completed');
    expect(f.kind).toBe('timeout');
    expect(f.retryable).toBe(true);
    expect(f.message).toBe('wake never completed');
    expect(f.timestamp).toBeGreaterThan(Date.now() - 1000);
  });

  it('parsingError() is NOT retryable and captures the cause', () => {
    const cause = new SyntaxError('bad json');
    const f = parsingError('adapter failed', cause);
    expect(f.kind).toBe('parsing_error');
    expect(f.retryable).toBe(false);
    expect(f.cause).toBe(cause);
  });

  it('apiError() is retryable and captures context', () => {
    const f = apiError('429 rate limited', undefined, { status: 429, provider: 'anthropic' });
    expect(f.kind).toBe('api_error');
    expect(f.retryable).toBe(true);
    expect(f.context).toEqual({ status: 429, provider: 'anthropic' });
  });

  it('policyViolation() is NOT retryable', () => {
    expect(policyViolation('tool denied').retryable).toBe(false);
  });

  it('impersonation() is NOT retryable', () => {
    expect(impersonation('cross-agent task mutation blocked').retryable).toBe(false);
  });

  it('wakeDeadlocked() is NOT retryable (already exhausted retries)', () => {
    expect(wakeDeadlocked('retry limit reached').retryable).toBe(false);
  });

  it('internalError() is retryable (transient by assumption)', () => {
    expect(internalError('something broke').retryable).toBe(true);
  });
});

describe('fromUnknown', () => {
  it('wraps an Error into AgentFailure with the chosen kind', () => {
    const err = new Error('boom');
    const f = fromUnknown(err, 'parsing_error');
    expect(f.kind).toBe('parsing_error');
    expect(f.message).toBe('boom');
    expect(f.cause).toBe(err);
    expect(f.retryable).toBe(false);
  });

  it('defaults to "internal" when no kind is specified', () => {
    expect(fromUnknown(new Error('x')).kind).toBe('internal');
  });

  it('stringifies non-Error values', () => {
    const f = fromUnknown('plain string');
    expect(f.message).toBe('plain string');
    expect(f.cause).toBeUndefined();
  });

  it('marks timeout/api_error/internal kinds as retryable by default', () => {
    expect(fromUnknown(new Error('t'), 'timeout').retryable).toBe(true);
    expect(fromUnknown(new Error('a'), 'api_error').retryable).toBe(true);
    expect(fromUnknown(new Error('i'), 'internal').retryable).toBe(true);
  });

  it('marks parsing/policy/impersonation/wake_deadlocked as non-retryable', () => {
    expect(fromUnknown(new Error('p'), 'parsing_error').retryable).toBe(false);
    expect(fromUnknown(new Error('p'), 'policy_violation').retryable).toBe(false);
    expect(fromUnknown(new Error('i'), 'impersonation').retryable).toBe(false);
    expect(fromUnknown(new Error('w'), 'wake_deadlocked').retryable).toBe(false);
  });
});

describe('isRetryable', () => {
  it('reflects the failure.retryable flag', () => {
    expect(isRetryable(timeout('t'))).toBe(true);
    expect(isRetryable(policyViolation('p'))).toBe(false);
  });
});
