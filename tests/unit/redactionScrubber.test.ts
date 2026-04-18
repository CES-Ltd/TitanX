/**
 * @license Apache-2.0
 * Unit tests for the Phase C v1.11.0 redaction extensions
 * (`scrubSecretPatterns`, `deepScrubForExport`).
 *
 * These are the belt-and-suspenders guards before learnings leave the
 * slave for the master. A false negative here leaks credentials into
 * the fleet-wide learning corpus, so the tests err on strict over
 * lenient — every pattern gets a targeted case.
 */

import { describe, it, expect } from 'vitest';
import os from 'os';
import { deepScrubForExport, scrubSecretPatterns } from '@process/utils/redaction';

describe('scrubSecretPatterns', () => {
  it('redacts OpenAI-style keys', () => {
    const input = 'key is sk-abc123def456ghi789jkl0 here';
    expect(scrubSecretPatterns(input)).toBe('key is ***REDACTED*** here');
  });

  it('redacts Anthropic-style keys', () => {
    const input = 'sk-ant-api03_AbCdEfGhIjKlMnOpQrStUvWxYz01 done';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
    expect(scrubSecretPatterns(input)).not.toContain('sk-ant-');
  });

  it('redacts Stripe live + test secret keys', () => {
    expect(scrubSecretPatterns('sk_live_abcdefghij0123456789')).toContain('***REDACTED***');
    expect(scrubSecretPatterns('sk_test_abcdefghij0123456789')).toContain('***REDACTED***');
  });

  it('redacts GitHub personal-access tokens', () => {
    const input = 'token ghp_abcdefghij0123456789abcdefghij0123456789 end';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
    expect(scrubSecretPatterns(input)).not.toContain('ghp_');
  });

  it('redacts AWS access keys', () => {
    expect(scrubSecretPatterns('AKIAIOSFODNN7EXAMPLE')).toBe('***REDACTED***');
  });

  it('redacts Bearer tokens with enough entropy', () => {
    const input = 'Authorization Bearer eyJabcdef123456.ghijklmnop.qrstuvwxyz';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
  });

  it('redacts JWT triples anywhere in text', () => {
    const input = 'cookie=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.abcdefghij';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
  });

  it('redacts long hex strings (>=32 chars) — catches raw hash/key dumps', () => {
    const input = 'hash=abcdef0123456789abcdef0123456789abcd done';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
  });

  it('redacts email addresses (PII minimization)', () => {
    const input = 'contact alice@example.com for details';
    expect(scrubSecretPatterns(input)).toContain('***REDACTED***');
    expect(scrubSecretPatterns(input)).not.toContain('alice@');
  });

  it('leaves benign strings untouched', () => {
    expect(scrubSecretPatterns('hello world 42 times')).toBe('hello world 42 times');
    expect(scrubSecretPatterns('task: refactor the auth module')).toBe('task: refactor the auth module');
  });

  it('handles empty + single-character inputs', () => {
    expect(scrubSecretPatterns('')).toBe('');
    expect(scrubSecretPatterns('a')).toBe('a');
  });
});

describe('deepScrubForExport', () => {
  it('scrubs nested object values', () => {
    const input = {
      task: 'send mail to alice@example.com',
      meta: { apiKey: 'this-should-go-via-key-name', userEmail: 'bob@example.com' },
    };
    const out = deepScrubForExport(input) as typeof input;
    expect(out.task).not.toContain('alice@');
    expect(out.task).toContain('***REDACTED***');
    expect(out.meta.apiKey).toBe('***REDACTED***');
    // Email in nested value is scrubbed by pattern AND by key when key
    // is a sensitive name. userEmail is not in sensitive key list but
    // its email value still gets scrubbed.
    expect(out.meta.userEmail).toContain('***REDACTED***');
  });

  it('scrubs values inside arrays', () => {
    // Build a homedir-prefixed path at runtime so the redactor's
    // os.homedir() lookup lines up with whatever environment the
    // test runs in (CI, dev laptop, contributor's macOS box, etc.).
    const homeFile = `${os.homedir()}/secret.txt`;
    const input = [{ step: 'call api with sk-abcdefghij1234567890' }, { step: `read ${homeFile}` }];
    const out = deepScrubForExport(input) as Array<{ step: string }>;
    expect(out[0]!.step).not.toContain('sk-');
    expect(out[1]!.step).not.toContain(os.homedir());
    expect(out[1]!.step).toContain('~');
  });

  it('preserves number + boolean leaves', () => {
    const input = { score: 0.87, enabled: true, count: 42 };
    const out = deepScrubForExport(input) as typeof input;
    expect(out.score).toBe(0.87);
    expect(out.enabled).toBe(true);
    expect(out.count).toBe(42);
  });

  it('handles null + undefined', () => {
    expect(deepScrubForExport(null)).toBeNull();
    expect(deepScrubForExport(undefined)).toBeUndefined();
  });

  it('returns same primitive for top-level strings', () => {
    expect(deepScrubForExport('safe text')).toBe('safe text');
    expect(deepScrubForExport('unsafe: sk-abcdefghij1234567890')).toBe('unsafe: ***REDACTED***');
  });
});
