/**
 * @license Apache-2.0
 * Data redaction and sanitization utilities for TitanX observability.
 * Ported from TitanClip's redaction system, adapted for AionUI conventions.
 */

import os from 'os';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'secret',
  'token',
  'api_key',
  'apiKey',
  'auth_token',
  'authToken',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'private_key',
  'privateKey',
  'jwt_secret',
  'master_key',
  'masterKey',
  'credential',
  'credentials',
  'material',
  'ciphertext',
]);

/**
 * Recursively sanitize a record by masking sensitive fields.
 * Returns a new object with sensitive values replaced by '***REDACTED***'.
 */
export function sanitizeRecord(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeRecord);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = sanitizeRecord(value);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Mask a username for log display: first char + asterisks.
 * "alice" → "a****"
 */
export function maskUsername(name: string): string {
  if (!name || name.length === 0) return '***';
  if (name.length === 1) return `${name}*`;
  return `${name[0]}${'*'.repeat(name.length - 1)}`;
}

/**
 * Redact home directory paths from text.
 * "/Users/alice/project/file.ts" → "~/project/file.ts"
 */
export function redactPaths(text: string): string {
  const homeDir = os.homedir();
  if (!homeDir) return text;
  return text.replaceAll(homeDir, '~');
}

/**
 * Detect if a key name likely holds a sensitive value.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SENSITIVE_KEYS.has(key) ||
    /api[_-]?key/i.test(lower) ||
    /access[_-]?token/i.test(lower) ||
    /auth[_-]?token/i.test(lower) ||
    /secret/i.test(lower) ||
    /password/i.test(lower) ||
    /private[_-]?key/i.test(lower)
  );
}

/**
 * Pattern-based scrubber for free-text string values (Phase C v1.11.0).
 *
 * `sanitizeRecord` scrubs by KEY name; this function scrubs by VALUE
 * shape. Used before exporting learnings to master: a trajectory's
 * step.result field is free-text and may carry API keys or tokens
 * that the model mentioned in its output. We scrub aggressively —
 * false positives just mean a safe placeholder appears, false negatives
 * mean a key leaks to master.
 *
 * Patterns covered (all replaced with '***REDACTED***'):
 *   - OpenAI keys:    sk-[A-Za-z0-9_-]{20,}
 *   - Anthropic keys: sk-ant-[A-Za-z0-9_-]{20,}
 *   - Stripe keys:    sk_(live|test)_[A-Za-z0-9]{20,}
 *   - GitHub PAT:     gh[ps]_[A-Za-z0-9]{36}
 *   - AWS access:     AKIA[0-9A-Z]{16}
 *   - Bearer tokens:  Bearer [A-Za-z0-9._~+/=-]{20,}
 *   - JWT triples:    eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
 *   - Long hex (≥32): raw hashes/keys where we can't tell the purpose
 *   - Email addresses:  local@domain  (PII minimization)
 *
 * NOT covered: home-directory paths (use `redactPaths` separately),
 * IPv4 addresses, ULIDs. Additive — new patterns land here without a
 * schema change to callers.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'github_pat', re: /gh[ps]_[A-Za-z0-9]{36}/g },
  { name: 'aws_access', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'bearer', re: /\bBearer [A-Za-z0-9._~+/=-]{20,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'long_hex', re: /\b[a-fA-F0-9]{32,}\b/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

export function scrubSecretPatterns(text: string): string {
  let result = text;
  for (const { re } of SECRET_PATTERNS) {
    result = result.replaceAll(re, '***REDACTED***');
  }
  return result;
}

/**
 * Deep scrub a JSON-serializable value. Applies both key-based
 * `sanitizeRecord` AND value-based pattern scrubbing to every string
 * leaf. Slower than either alone; reserved for before-export-to-master
 * paths where both attack vectors matter.
 */
export function deepScrubForExport(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSecretPatterns(redactPaths(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map(deepScrubForExport);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = '***REDACTED***';
      } else {
        result[key] = deepScrubForExport(v);
      }
    }
    return result;
  }

  return value;
}
