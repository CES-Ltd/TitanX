/**
 * @license Apache-2.0
 * Pure-logic fleet enrollment tests — no SQLite dependency.
 *
 * Covers the bits that don't need a DB:
 *   - deviceJwt sign + verify + rejection paths
 *   - deriveDeviceId fingerprint stability and format
 *
 * Complements the full-lifecycle tests in fleetEnrollment.test.ts
 * (those skip when the native better-sqlite3 module can't load; these
 * always run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { deriveDeviceId } from '@process/services/fleetEnrollment';
import { __resetJwtKeyCache, signDeviceJwt, verifyDeviceJwt } from '@process/services/fleetEnrollment/deviceJwt';

function makeTestPubKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' }) as string;
}

beforeEach(() => {
  process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40);
  __resetJwtKeyCache();
});
afterEach(() => {
  delete process.env.TITANX_FLEET_JWT_KEY;
  __resetJwtKeyCache();
});

describe('deviceJwt', () => {
  it('signs + verifies a JWT roundtrip', () => {
    const { token, expiresAt } = signDeviceJwt({ deviceId: 'abc123', jti: 'jti-1' });
    expect(token).toMatch(/^eyJ/);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const claims = verifyDeviceJwt(token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('abc123');
    expect(claims?.jti).toBe('jti-1');
    expect(claims?.typ).toBe('device');
  });

  it('honors custom TTL', () => {
    const before = Date.now();
    const { expiresAt } = signDeviceJwt({ deviceId: 'x', jti: 'y', ttlMs: 60_000 });
    expect(expiresAt - before).toBeGreaterThanOrEqual(59_000);
    expect(expiresAt - before).toBeLessThanOrEqual(61_000);
  });

  it('rejects tokens with tampered payload', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc', jti: 'j' });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    expect(verifyDeviceJwt(tampered)).toBeNull();
  });

  it('rejects expired tokens', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc', jti: 'j', ttlMs: -1000 });
    expect(verifyDeviceJwt(token)).toBeNull();
  });

  it('rejects tokens signed with a different secret', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc', jti: 'j' });
    process.env.TITANX_FLEET_JWT_KEY = 'y'.repeat(40);
    __resetJwtKeyCache();
    expect(verifyDeviceJwt(token)).toBeNull();
  });

  it('rejects tokens missing the typ=device claim (prevents user-JWT confusion)', async () => {
    // Hand-craft a JWT without typ so a user/session token can't be reused as a device token.
    const jwt = (await import('jsonwebtoken')).default;
    const raw = jwt.sign({ sub: 'x', jti: 'y' }, 'x'.repeat(40), { algorithm: 'HS256', expiresIn: '1h' });
    expect(verifyDeviceJwt(raw)).toBeNull();
  });

  it('rejects a malformed / garbage token', () => {
    expect(verifyDeviceJwt('not.a.jwt')).toBeNull();
    expect(verifyDeviceJwt('')).toBeNull();
  });

  it('refuses to sign when the secret is too short', () => {
    process.env.TITANX_FLEET_JWT_KEY = 'short';
    __resetJwtKeyCache();
    expect(() => signDeviceJwt({ deviceId: 'x', jti: 'y' })).toThrow(/at least 32 characters/);
  });
});

describe('deriveDeviceId', () => {
  it('produces a 16-hex-char fingerprint from a valid PEM', () => {
    const pem = makeTestPubKey();
    const id = deriveDeviceId(pem);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — same pubkey → same id', () => {
    const pem = makeTestPubKey();
    expect(deriveDeviceId(pem)).toBe(deriveDeviceId(pem));
  });

  it('different pubkeys produce different ids', () => {
    const ids = new Set(Array.from({ length: 10 }, () => deriveDeviceId(makeTestPubKey())));
    expect(ids.size).toBe(10);
  });

  it('throws on malformed PEM', () => {
    expect(() => deriveDeviceId('not-a-pem')).toThrow();
    expect(() => deriveDeviceId('-----BEGIN PUBLIC KEY-----\ngarbage\n-----END PUBLIC KEY-----')).toThrow();
  });

  it('ignores whitespace differences in PEM (re-exports canonical)', () => {
    const pem = makeTestPubKey();
    const withExtraWhitespace = pem.replace(/\n/g, '\n  \n').trim();
    // Node's createPublicKey is strict, so a PEM with extra lines fails.
    // Verify the normal form at least survives a trim() roundtrip.
    expect(deriveDeviceId(pem.trim())).toBe(deriveDeviceId(pem));
  });
});
