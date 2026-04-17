/**
 * @license Apache-2.0
 * Device JWT signing + verification for the fleet control plane.
 *
 * Each enrolled slave gets a 30-day JWT at enrollment time. The token
 * is signed with a master-only HS256 secret persisted at
 * `<userData>/.fleet-jwt-key`. Keys rotate only via explicit admin
 * action (v1.9.27 doesn't ship rotation UI — that lands in Phase G).
 *
 * Why HS256 not RS256? The slave only *presents* the token to the
 * master on heartbeat; it doesn't verify its own token or anyone
 * else's. One secret, one verifier — HS256 keeps the surface minimal.
 * Ed25519 device signatures on individual requests (separate path)
 * provide the asymmetric layer.
 *
 * Secret hygiene mirrors the audit HMAC pattern from activityLog:
 *   - env var `TITANX_FLEET_JWT_KEY` (>= 32 chars) takes priority
 *   - else read from `.fleet-jwt-key` with 0o600
 *   - else generate a fresh 32-byte key on first use; fail LOUD if the
 *     write fails (silent fallback would let an attacker forge JWTs by
 *     deleting the file)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import type { DeviceJwtClaims } from './types';

const DEFAULT_JWT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_KEY_CHARS = 32;

let _jwtKey: string | null = null;

/** Read-or-generate the master-only device-JWT signing key. */
function getDeviceJwtKey(): string {
  if (_jwtKey) return _jwtKey;

  // Priority 1: environment variable (useful for tests + containerized masters).
  if (process.env.TITANX_FLEET_JWT_KEY) {
    if (process.env.TITANX_FLEET_JWT_KEY.length < MIN_KEY_CHARS) {
      throw new Error(`[FleetJwt] TITANX_FLEET_JWT_KEY must be at least ${String(MIN_KEY_CHARS)} characters.`);
    }
    _jwtKey = process.env.TITANX_FLEET_JWT_KEY;
    return _jwtKey;
  }

  // Priority 2: per-install persistent random key file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron');
  const keyPath = path.join(app.getPath('userData'), '.fleet-jwt-key');

  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing.length < MIN_KEY_CHARS) {
      throw new Error(
        `[FleetJwt] Key file at ${keyPath} is corrupted or truncated (< ${String(MIN_KEY_CHARS)} chars).`
      );
    }
    _jwtKey = existing;
    return _jwtKey;
  }

  // Fresh install: generate cryptographically-strong 32-byte key.
  const newKey = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
  } catch (err) {
    throw new Error(
      `[FleetJwt] Failed to persist signing key to ${keyPath}. Refusing to proceed with in-memory-only key: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  _jwtKey = newKey;
  console.log('[FleetJwt] Generated new device-JWT signing key');
  return _jwtKey;
}

/** Clear the cached key — test-only hook. */
export function __resetJwtKeyCache(): void {
  _jwtKey = null;
}

/** Issue a new device JWT. `jti` is caller-supplied so the enrollment
 *  service can persist it against the device row for revocation lookup. */
export function signDeviceJwt(params: { deviceId: string; jti: string; ttlMs?: number }): {
  token: string;
  expiresAt: number;
} {
  const key = getDeviceJwtKey();
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.floor((params.ttlMs ?? DEFAULT_JWT_TTL_MS) / 1000);
  const claims: DeviceJwtClaims = {
    sub: params.deviceId,
    iat: now,
    exp: now + ttl,
    jti: params.jti,
    typ: 'device',
  };
  const token = jwt.sign(claims, key, { algorithm: 'HS256' });
  return { token, expiresAt: claims.exp * 1000 };
}

/** Parsed JWT claims if valid + well-formed + un-expired; null otherwise.
 *  Note: does NOT check revocation — caller must cross-reference `jti`
 *  against `fleet_enrollments.device_jwt_jti` to catch revoked tokens
 *  that haven't expired yet. */
export function verifyDeviceJwt(token: string): DeviceJwtClaims | null {
  try {
    const key = getDeviceJwtKey();
    const decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) return null;
    const claims = decoded as Record<string, unknown>;
    if (claims.typ !== 'device') return null;
    if (typeof claims.sub !== 'string' || typeof claims.jti !== 'string') return null;
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
    return {
      sub: claims.sub,
      iat: claims.iat,
      exp: claims.exp,
      jti: claims.jti,
      typ: 'device',
    };
  } catch {
    return null;
  }
}
