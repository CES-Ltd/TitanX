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
