/**
 * @license Apache-2.0
 * Tests for TitanX data redaction utilities.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeRecord, maskUsername, isSensitiveKey } from '@process/utils/redaction';

describe('redaction/sanitizeRecord', () => {
  it('should redact known sensitive keys', () => {
    const input = { name: 'test', password: 'secret123', api_key: 'sk-abc' };
    const result = sanitizeRecord(input) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.password).toBe('***REDACTED***');
    expect(result.api_key).toBe('***REDACTED***');
  });

  it('should recursively sanitize nested objects', () => {
    const input = { config: { token: 'tok-123', url: 'https://api.example.com' } };
    const result = sanitizeRecord(input) as Record<string, Record<string, unknown>>;
    expect(result.config.token).toBe('***REDACTED***');
    expect(result.config.url).toBe('https://api.example.com');
  });

  it('should sanitize arrays of objects', () => {
    const input = [{ secret: 'val1' }, { secret: 'val2' }];
    const result = sanitizeRecord(input) as Array<Record<string, unknown>>;
    expect(result[0].secret).toBe('***REDACTED***');
    expect(result[1].secret).toBe('***REDACTED***');
  });

  it('should pass through primitives unchanged', () => {
    expect(sanitizeRecord(null)).toBeNull();
    expect(sanitizeRecord(undefined)).toBeUndefined();
    expect(sanitizeRecord(42)).toBe(42);
    expect(sanitizeRecord('hello')).toBe('hello');
    expect(sanitizeRecord(true)).toBe(true);
  });
});

describe('redaction/maskUsername', () => {
  it('should mask username keeping first character', () => {
    expect(maskUsername('alice')).toBe('a****');
    expect(maskUsername('bob')).toBe('b**');
  });

  it('should handle single-character names', () => {
    expect(maskUsername('a')).toBe('a*');
  });

  it('should handle empty strings', () => {
    expect(maskUsername('')).toBe('***');
  });
});

describe('redaction/isSensitiveKey', () => {
  it('should detect common sensitive key names', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('access_token')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
    expect(isSensitiveKey('private_key')).toBe(true);
  });

  it('should not flag non-sensitive keys', () => {
    expect(isSensitiveKey('name')).toBe(false);
    expect(isSensitiveKey('email')).toBe(false);
    expect(isSensitiveKey('url')).toBe(false);
  });
});
