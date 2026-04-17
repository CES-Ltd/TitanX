/**
 * @license Apache-2.0
 * Unit tests for the fleetEnrollment service (Phase B Week 1).
 *
 * Exercises the full lifecycle end-to-end against an in-memory SQLite
 * driver:
 *   - token generation produces plaintext + persists hash only
 *   - enrollment succeeds on first use; idempotent for same device
 *   - enrollment fails for expired / revoked / used-by-other-device
 *   - device roster + heartbeat + revoke produce the expected state
 *   - JWT verification catches invalid / superseded / revoked tokens
 *
 * Keys off `BetterSqlite3Driver` — the harness skips if the native
 * module can't be loaded (the Electron ABI mismatch prevents native
 * SQLite in some test environments; same pattern as governance tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import * as fleetEnrollment from '@process/services/fleetEnrollment';
import { __resetJwtKeyCache, signDeviceJwt, verifyDeviceJwt } from '@process/services/fleetEnrollment/deviceJwt';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

const ADMIN_USER = 'admin-user-1';

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 61);
  // Seed admin row so audit FK is satisfied where relevant
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ADMIN_USER, 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

/** Generate a fresh Ed25519 keypair for a test device. */
function makeTestDevice(): { pubKeyPem: string; deviceId: string } {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const deviceId = fleetEnrollment.deriveDeviceId(pubKeyPem);
  return { pubKeyPem, deviceId };
}

// ── Tests ───────────────────────────────────────────────────────────────

describeOrSkip('fleetEnrollment — token generation + admin mgmt', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40); // stable test key
    __resetJwtKeyCache();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
    delete process.env.TITANX_FLEET_JWT_KEY;
    __resetJwtKeyCache();
  });

  it('generates a cryptographically-strong token + persists only the hash', () => {
    const result = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    expect(result.token).toMatch(/^[0-9a-f]{48}$/); // 24 bytes hex
    expect(result.tokenHash).toHaveLength(64); // SHA256 hex
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // DB row stores hash, not plaintext
    const row = db
      .prepare('SELECT * FROM fleet_enrollment_tokens WHERE token_hash = ?')
      .get(result.tokenHash) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(result.tokenHash);
    expect(row.issued_by).toBe(ADMIN_USER);
    // Plaintext never appears in any column
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(result.token);
  });

  it('honors ttlHours override', () => {
    const before = Date.now();
    const result = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER, ttlHours: 1 });
    const elapsed = result.expiresAt - before;
    expect(elapsed).toBeLessThanOrEqual(1 * 60 * 60 * 1000 + 1000);
    expect(elapsed).toBeGreaterThanOrEqual(1 * 60 * 60 * 1000 - 1000);
  });

  it('listActiveTokens excludes expired / revoked / used tokens', () => {
    const active = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    // Mint a second token then revoke it
    const revoked = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    fleetEnrollment.revokeEnrollmentToken(db, { tokenHash: revoked.tokenHash, revokedBy: ADMIN_USER });
    // Mint a third and forcibly expire it via direct DB poke
    const expired = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    db.prepare('UPDATE fleet_enrollment_tokens SET expires_at = ? WHERE token_hash = ?').run(
      Date.now() - 1000,
      expired.tokenHash
    );

    const list = fleetEnrollment.listActiveTokens(db);
    expect(list.map((t) => t.tokenHash)).toEqual([active.tokenHash]);
  });

  it('revokeEnrollmentToken returns true once + false on re-revoke', () => {
    const t = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    expect(fleetEnrollment.revokeEnrollmentToken(db, { tokenHash: t.tokenHash, revokedBy: ADMIN_USER })).toBe(true);
    expect(fleetEnrollment.revokeEnrollmentToken(db, { tokenHash: t.tokenHash, revokedBy: ADMIN_USER })).toBe(false);
  });
});

describeOrSkip('fleetEnrollment — enrollDevice happy + error paths', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40);
    __resetJwtKeyCache();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
    delete process.env.TITANX_FLEET_JWT_KEY;
    __resetJwtKeyCache();
  });

  it('enrolls a fresh device and issues a JWT bound to the device id', () => {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const device = makeTestDevice();
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'laptop-01.example.com',
      osVersion: 'darwin 24.0.0',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('enroll failed');
    expect(result.deviceId).toBe(device.deviceId);
    expect(result.deviceJwt).toMatch(/^eyJ/); // JWT header starts with {"alg"
    expect(result.jwtExpiresAt).toBeGreaterThan(Date.now());

    // DB row exists with status=enrolled
    const row = db.prepare('SELECT * FROM fleet_enrollments WHERE device_id = ?').get(result.deviceId) as Record<
      string,
      unknown
    >;
    expect(row.status).toBe('enrolled');
    expect(row.hostname).toBe('laptop-01.example.com');
    expect(row.titanx_version).toBe('1.9.27');

    // Token marked used
    const tokenRow = db
      .prepare('SELECT used_at, used_by_device_id FROM fleet_enrollment_tokens WHERE used_by_device_id = ?')
      .get(result.deviceId) as Record<string, unknown>;
    expect(tokenRow.used_at).toBeDefined();
    expect(tokenRow.used_by_device_id).toBe(result.deviceId);
  });

  it('rejects enrollment with an unknown token', () => {
    const device = makeTestDevice();
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: 'not-a-real-token',
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/not recognized/);
  });

  it('rejects enrollment with a revoked token', () => {
    const { token, tokenHash } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    fleetEnrollment.revokeEnrollmentToken(db, { tokenHash, revokedBy: ADMIN_USER });
    const device = makeTestDevice();
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/revoked/);
  });

  it('rejects enrollment with an expired token', () => {
    const { token, tokenHash } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    // Forcibly expire
    db.prepare('UPDATE fleet_enrollment_tokens SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, tokenHash);
    const device = makeTestDevice();
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/expired/);
  });

  it('refuses reuse of a token by a different device but allows same device', () => {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const deviceA = makeTestDevice();
    const deviceB = makeTestDevice();
    const first = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: deviceA.pubKeyPem,
      hostname: 'a',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(first.ok).toBe(true);

    // Same device can re-enroll — get a fresh JWT
    const reEnroll = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: deviceA.pubKeyPem,
      hostname: 'a',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(reEnroll.ok).toBe(true);

    // Different device is rejected
    const byB = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: deviceB.pubKeyPem,
      hostname: 'b',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(byB.ok).toBe(false);
    if (byB.ok) throw new Error('unreachable');
    expect(byB.error).toMatch(/already been used/);
  });

  it('rejects malformed pubkey PEM with a useful message', () => {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: '-----BEGIN PUBLIC KEY-----\nnot base64\n-----END PUBLIC KEY-----\n'.padEnd(200, ' '),
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toMatch(/not a valid public key|is required/);
  });

  it('rejects missing input fields', () => {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const device = makeTestDevice();
    const result = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: '',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(result.ok).toBe(false);
  });

  it('re-enrollment rotates the JWT jti so stale tokens are rejected', () => {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const device = makeTestDevice();
    const first = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    const second = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.deviceJwt).not.toBe(first.deviceJwt);

    // Old JWT rejected (jti mismatch)
    const verifyStale = fleetEnrollment.verifyDeviceRequest(db, first.deviceJwt);
    expect('error' in verifyStale).toBe(true);
    // New JWT accepted
    const verifyFresh = fleetEnrollment.verifyDeviceRequest(db, second.deviceJwt);
    expect('deviceId' in verifyFresh).toBe(true);
  });
});

describeOrSkip('fleetEnrollment — roster + heartbeat + revoke', () => {
  let db: ISqliteDriver;

  beforeEach(() => {
    process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40);
    __resetJwtKeyCache();
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
    delete process.env.TITANX_FLEET_JWT_KEY;
    __resetJwtKeyCache();
  });

  function enrollOne(): { deviceId: string; deviceJwt: string } {
    const { token } = fleetEnrollment.generateEnrollmentToken(db, { issuedBy: ADMIN_USER });
    const device = makeTestDevice();
    const r = fleetEnrollment.enrollDevice(db, {
      enrollmentToken: token,
      devicePubKeyPem: device.pubKeyPem,
      hostname: 'h1',
      osVersion: 'darwin',
      titanxVersion: '1.9.27',
    });
    if (!r.ok) throw new Error('enroll failed in test helper');
    return { deviceId: r.deviceId, deviceJwt: r.deviceJwt };
  }

  it('listDevices returns enrolled devices ordered newest first', () => {
    const a = enrollOne();
    const b = enrollOne();
    const list = fleetEnrollment.listDevices(db);
    expect(list.map((d) => d.deviceId)).toEqual([b.deviceId, a.deviceId]);
    for (const d of list) expect(d.status).toBe('enrolled');
  });

  it('recordHeartbeat updates last_heartbeat_at', () => {
    const { deviceId } = enrollOne();
    const before = fleetEnrollment.getDevice(db, deviceId);
    expect(before?.lastHeartbeatAt).toBeUndefined();

    const result = fleetEnrollment.recordHeartbeat(db, deviceId);
    expect(result.ok).toBe(true);

    const after = fleetEnrollment.getDevice(db, deviceId);
    expect(after?.lastHeartbeatAt).toBeDefined();
    expect(after!.lastHeartbeatAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('recordHeartbeat rejects unknown + revoked devices', () => {
    expect(fleetEnrollment.recordHeartbeat(db, 'unknown').ok).toBe(false);
    const { deviceId } = enrollOne();
    fleetEnrollment.revokeDevice(db, { deviceId, revokedBy: ADMIN_USER });
    expect(fleetEnrollment.recordHeartbeat(db, deviceId).ok).toBe(false);
  });

  it('revokeDevice flips status + returns ok on first revoke', () => {
    const { deviceId } = enrollOne();
    expect(fleetEnrollment.revokeDevice(db, { deviceId, revokedBy: ADMIN_USER }).ok).toBe(true);
    expect(fleetEnrollment.getDevice(db, deviceId)?.status).toBe('revoked');

    // Second revoke is a no-op
    expect(fleetEnrollment.revokeDevice(db, { deviceId, revokedBy: ADMIN_USER }).ok).toBe(false);
    // Unknown device also fails
    expect(fleetEnrollment.revokeDevice(db, { deviceId: 'unknown', revokedBy: ADMIN_USER }).ok).toBe(false);
  });

  it('verifyDeviceRequest accepts valid JWT + rejects revoked', () => {
    const { deviceId, deviceJwt } = enrollOne();
    const okResult = fleetEnrollment.verifyDeviceRequest(db, deviceJwt);
    expect('deviceId' in okResult).toBe(true);
    if ('deviceId' in okResult) expect(okResult.deviceId).toBe(deviceId);

    fleetEnrollment.revokeDevice(db, { deviceId, revokedBy: ADMIN_USER });
    const revoked = fleetEnrollment.verifyDeviceRequest(db, deviceJwt);
    expect('error' in revoked).toBe(true);
  });

  it('verifyDeviceRequest rejects a JWT signed with a different key', () => {
    const { deviceId } = enrollOne();
    // Swap keys mid-flight and re-sign — simulates an attacker-forged token
    process.env.TITANX_FLEET_JWT_KEY = 'y'.repeat(40);
    __resetJwtKeyCache();
    const forged = signDeviceJwt({ deviceId, jti: 'forged' });
    // Back to real key for verification
    process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40);
    __resetJwtKeyCache();
    const result = fleetEnrollment.verifyDeviceRequest(db, forged.token);
    expect('error' in result).toBe(true);
  });
});

describeOrSkip('deviceJwt primitives', () => {
  beforeEach(() => {
    process.env.TITANX_FLEET_JWT_KEY = 'x'.repeat(40);
    __resetJwtKeyCache();
  });
  afterEach(() => {
    delete process.env.TITANX_FLEET_JWT_KEY;
    __resetJwtKeyCache();
  });

  it('signs + verifies a JWT roundtrip', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc123', jti: 'jti-1' });
    const claims = verifyDeviceJwt(token);
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('abc123');
    expect(claims?.jti).toBe('jti-1');
    expect(claims?.typ).toBe('device');
  });

  it('rejects tokens with tampered payload', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc123', jti: 'jti-1' });
    const parts = token.split('.');
    // Flip a character in the payload
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    expect(verifyDeviceJwt(tampered)).toBeNull();
  });

  it('rejects expired tokens', () => {
    const { token } = signDeviceJwt({ deviceId: 'abc', jti: 'j', ttlMs: -1000 });
    expect(verifyDeviceJwt(token)).toBeNull();
  });

  it('rejects tokens missing the typ=device claim (defense against user-JWT confusion)', () => {
    // Hand-craft a JWT without typ
    const jwt = require('jsonwebtoken');
    const raw = jwt.sign({ sub: 'x', jti: 'y' }, 'x'.repeat(40), { algorithm: 'HS256', expiresIn: '1h' });
    expect(verifyDeviceJwt(raw)).toBeNull();
  });

  it('refuses short keys at initialization', () => {
    process.env.TITANX_FLEET_JWT_KEY = 'too-short';
    __resetJwtKeyCache();
    expect(() => signDeviceJwt({ deviceId: 'x', jti: 'y' })).toThrow(/at least 32 characters/);
  });
});
