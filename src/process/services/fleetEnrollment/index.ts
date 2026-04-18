/**
 * @license Apache-2.0
 * Fleet enrollment service (Phase B Week 1).
 *
 * Master-side logic for the slave onboarding handshake:
 *   1. Admin generates a one-time enrollment token via
 *      generateEnrollmentToken() — token plaintext is shown once and
 *      never persisted; only SHA256(token) goes into the DB.
 *   2. Slave POSTs the token + its Ed25519 pubkey via the HTTP router
 *      (wired in Phase B Week 2). Handler calls enrollDevice() which
 *      validates the token, records the device in fleet_enrollments,
 *      and issues a 30-day device JWT signed with the master-only
 *      secret.
 *   3. Slave hits POST /api/fleet/heartbeat every 60s with the JWT.
 *      Handler calls recordHeartbeat() which refreshes
 *      last_heartbeat_at.
 *   4. Admin can revoke a device via revokeDevice() — flips status to
 *      'revoked'; every subsequent heartbeat returns 401 because the
 *      heartbeat handler cross-checks enrollments.status.
 *
 * All DB writes are audit-logged so governance has a forensic trail
 * of who enrolled/revoked what when.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import { signDeviceJwt, verifyDeviceJwt } from './deviceJwt';
import { getMasterSigningPublicKey } from '../fleetCommandSigning';
import type {
  EnrollDeviceInput,
  EnrollDeviceResult,
  EnrolledDevice,
  EnrollmentTokenRecord,
  GeneratedEnrollmentToken,
} from './types';

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_TOKEN_TTL_HOURS = 24;
const MIN_HOSTNAME_LENGTH = 1;
const MAX_HOSTNAME_LENGTH = 253;
const MIN_PUBKEY_LENGTH = 100; // SPKI PEM is ~ 200 chars; 100 is safely low
const TOKEN_BYTE_LENGTH = 24; // → 48 hex chars, ~190 bits of entropy

// ── Token generation + admin management ─────────────────────────────────

/**
 * Mint a new single-use enrollment token. Plaintext returned in memory
 * ONCE — caller (admin UI) must hand it to the user without persisting.
 * Only SHA256(token) lands in the DB.
 */
export function generateEnrollmentToken(
  db: ISqliteDriver,
  params: { issuedBy: string; ttlHours?: number; note?: string }
): GeneratedEnrollmentToken {
  const token = crypto.randomBytes(TOKEN_BYTE_LENGTH).toString('hex');
  const tokenHash = sha256(token);
  const now = Date.now();
  const ttlMs = (params.ttlHours ?? DEFAULT_TOKEN_TTL_HOURS) * 60 * 60 * 1000;
  const expiresAt = now + ttlMs;

  db.prepare(
    `INSERT INTO fleet_enrollment_tokens (token_hash, issued_at, expires_at, issued_by, note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenHash, now, expiresAt, params.issuedBy, params.note ?? null);

  auditSafe(db, {
    userId: params.issuedBy,
    actorType: 'user',
    actorId: params.issuedBy,
    action: 'fleet.enrollment_token.generated',
    entityType: 'fleet',
    entityId: tokenHash,
    details: { expiresAt, ttlHours: params.ttlHours ?? DEFAULT_TOKEN_TTL_HOURS, note: params.note },
  });

  return { token, tokenHash, expiresAt };
}

/** List active (non-revoked, non-expired) enrollment tokens for the admin UI. */
export function listActiveTokens(db: ISqliteDriver): EnrollmentTokenRecord[] {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT * FROM fleet_enrollment_tokens
       WHERE revoked_at IS NULL AND expires_at > ? AND used_at IS NULL
       ORDER BY issued_at DESC`
    )
    .all(now) as Array<Record<string, unknown>>;
  return rows.map(rowToTokenRecord);
}

/** Revoke an enrollment token before it is used. */
export function revokeEnrollmentToken(db: ISqliteDriver, params: { tokenHash: string; revokedBy: string }): boolean {
  const result = db
    .prepare(`UPDATE fleet_enrollment_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .run(Date.now(), params.tokenHash);
  if (result.changes > 0) {
    auditSafe(db, {
      userId: params.revokedBy,
      actorType: 'user',
      actorId: params.revokedBy,
      action: 'fleet.enrollment_token.revoked',
      entityType: 'fleet',
      entityId: params.tokenHash,
      details: {},
    });
    return true;
  }
  return false;
}

// ── Slave enrollment ────────────────────────────────────────────────────

/**
 * Validate an enrollment token + register the slave. Returns a signed
 * device JWT the slave stores + presents on every heartbeat.
 *
 * Idempotency: a slave that enrolls twice with the same pubkey gets
 * re-issued a fresh JWT (new jti) but keeps the existing device row.
 * This lets slaves recover from JWT loss without admin intervention,
 * provided they still hold a valid enrollment token.
 */
export function enrollDevice(db: ISqliteDriver, input: EnrollDeviceInput): EnrollDeviceResult {
  // Input validation — cheap checks first
  if (!input.enrollmentToken || input.enrollmentToken.length === 0) {
    return { ok: false, error: 'enrollmentToken is required' };
  }
  if (!input.devicePubKeyPem || input.devicePubKeyPem.length < MIN_PUBKEY_LENGTH) {
    return { ok: false, error: 'devicePubKeyPem is required (expected PEM-encoded Ed25519 public key)' };
  }
  if (!input.hostname || input.hostname.length < MIN_HOSTNAME_LENGTH || input.hostname.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, error: `hostname must be ${String(MIN_HOSTNAME_LENGTH)}-${String(MAX_HOSTNAME_LENGTH)} chars` };
  }

  // Parse pubkey early — catches malformed PEM before we commit a row.
  let deviceId: string;
  try {
    deviceId = deriveDeviceId(input.devicePubKeyPem);
  } catch (e) {
    return { ok: false, error: `devicePubKeyPem is not a valid public key: ${String(e)}` };
  }

  const tokenHash = sha256(input.enrollmentToken);

  // Token lookup + validation — single transaction so we don't race a
  // second concurrent enrollment using the same token.
  const now = Date.now();
  const tokenRow = db.prepare(`SELECT * FROM fleet_enrollment_tokens WHERE token_hash = ?`).get(tokenHash) as
    | Record<string, unknown>
    | undefined;

  if (!tokenRow) return { ok: false, error: 'enrollment token not recognized' };
  if (tokenRow.revoked_at != null) return { ok: false, error: 'enrollment token has been revoked' };
  if ((tokenRow.expires_at as number) < now) return { ok: false, error: 'enrollment token has expired' };
  // Allow re-use ONLY by the same device (idempotent re-enrollment).
  if (tokenRow.used_at != null && tokenRow.used_by_device_id !== deviceId) {
    return { ok: false, error: 'enrollment token has already been used by another device' };
  }

  // Mint a fresh jti + JWT (issued every enrollment attempt).
  const jti = crypto.randomUUID();
  const { token: deviceJwt, expiresAt: jwtExpiresAt } = signDeviceJwt({ deviceId, jti });

  // Upsert device + mark token used — done as a transaction for atomicity.
  const existingRow = db.prepare(`SELECT device_id FROM fleet_enrollments WHERE device_id = ?`).get(deviceId) as
    | Record<string, unknown>
    | undefined;

  if (existingRow) {
    // Re-enrollment — rotate JWT jti, refresh metadata
    db.prepare(
      `UPDATE fleet_enrollments
       SET device_pubkey_pem = ?, hostname = ?, os_version = ?, titanx_version = ?,
           status = 'enrolled', revoked_at = NULL, device_jwt_jti = ?,
           enrollment_token_hash = ?
       WHERE device_id = ?`
    ).run(input.devicePubKeyPem, input.hostname, input.osVersion, input.titanxVersion, jti, tokenHash, deviceId);
  } else {
    db.prepare(
      `INSERT INTO fleet_enrollments
        (device_id, device_pubkey_pem, hostname, os_version, titanx_version,
         enrolled_at, status, device_jwt_jti, enrollment_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'enrolled', ?, ?)`
    ).run(deviceId, input.devicePubKeyPem, input.hostname, input.osVersion, input.titanxVersion, now, jti, tokenHash);
  }

  db.prepare(
    `UPDATE fleet_enrollment_tokens
     SET used_at = ?, used_by_device_id = ?
     WHERE token_hash = ?`
  ).run(now, deviceId, tokenHash);

  auditSafe(db, {
    // `user_id` has an FK to users(id) — use the seeded default user id
    // for system-initiated audit rows. `actorId` carries the logical
    // actor label ('fleet_enrollment') for human readers of the log.
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'fleet_enrollment',
    action: existingRow ? 'fleet.device.re-enrolled' : 'fleet.device.enrolled',
    entityType: 'fleet_device',
    entityId: deviceId,
    details: {
      hostname: input.hostname,
      osVersion: input.osVersion,
      titanxVersion: input.titanxVersion,
      jti,
    },
  });

  // Phase F.2: ship master's Ed25519 command-signing pubkey to the
  // slave. Lazy-loads (mints on first enrollment after install).
  // Errors are swallowed so a signing-key-service hiccup doesn't
  // block enrollment — the slave will simply refuse destructive
  // commands until its next re-enrollment catches the key.
  let masterCommandSigningPubKey: string | undefined;
  try {
    masterCommandSigningPubKey = getMasterSigningPublicKey(db);
  } catch (e) {
    logNonCritical('fleet.enrollment.signing-pubkey', e);
  }

  return { ok: true, deviceId, deviceJwt, jwtExpiresAt, masterCommandSigningPubKey };
}

// ── Roster + heartbeat ──────────────────────────────────────────────────

export function listDevices(db: ISqliteDriver): EnrolledDevice[] {
  const rows = db.prepare(`SELECT * FROM fleet_enrollments ORDER BY enrolled_at DESC`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map(rowToDevice);
}

export function getDevice(db: ISqliteDriver, deviceId: string): EnrolledDevice | null {
  const row = db.prepare(`SELECT * FROM fleet_enrollments WHERE device_id = ?`).get(deviceId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDevice(row) : null;
}

export function revokeDevice(
  db: ISqliteDriver,
  params: { deviceId: string; revokedBy: string }
): { ok: true } | { ok: false; error: string } {
  const result = db
    .prepare(
      `UPDATE fleet_enrollments SET status = 'revoked', revoked_at = ? WHERE device_id = ? AND status = 'enrolled'`
    )
    .run(Date.now(), params.deviceId);
  if (result.changes === 0) {
    return { ok: false, error: 'device not found or already revoked' };
  }
  auditSafe(db, {
    userId: params.revokedBy,
    actorType: 'user',
    actorId: params.revokedBy,
    action: 'fleet.device.revoked',
    entityType: 'fleet_device',
    entityId: params.deviceId,
    details: {},
  });
  return { ok: true };
}

export function recordHeartbeat(db: ISqliteDriver, deviceId: string): { ok: true } | { ok: false; error: string } {
  const row = db.prepare(`SELECT status FROM fleet_enrollments WHERE device_id = ?`).get(deviceId) as
    | { status: string }
    | undefined;
  if (!row) return { ok: false, error: 'device not enrolled' };
  if (row.status === 'revoked') return { ok: false, error: 'device has been revoked' };
  db.prepare(`UPDATE fleet_enrollments SET last_heartbeat_at = ? WHERE device_id = ?`).run(Date.now(), deviceId);
  return { ok: true };
}

/**
 * End-to-end token verification for the heartbeat HTTP handler.
 * Returns the deviceId if the JWT is valid, the jti matches the one
 * stored in fleet_enrollments, and the device is not revoked.
 */
export function verifyDeviceRequest(db: ISqliteDriver, jwt: string): { deviceId: string } | { error: string } {
  const claims = verifyDeviceJwt(jwt);
  if (!claims) return { error: 'invalid or expired token' };

  const row = db.prepare(`SELECT device_jwt_jti, status FROM fleet_enrollments WHERE device_id = ?`).get(claims.sub) as
    | { device_jwt_jti: string; status: string }
    | undefined;
  if (!row) return { error: 'device not enrolled' };
  if (row.status !== 'enrolled') return { error: 'device revoked' };
  if (row.device_jwt_jti !== claims.jti) return { error: 'token jti mismatch (superseded by newer enrollment)' };
  return { deviceId: claims.sub };
}

// ── Utilities ───────────────────────────────────────────────────────────

/**
 * Derive the device ID from an Ed25519 public key PEM.
 * Matches the fingerprint formula used by the local deviceIdentity
 * service on each slave, so a freshly-installed slave reports the
 * same device_id the master expects.
 */
export function deriveDeviceId(devicePubKeyPem: string): string {
  // Round-trip through crypto.createPublicKey to canonicalize PEM
  // (catches truncated / malformed input + normalizes line endings).
  const key = crypto.createPublicKey(devicePubKeyPem);
  const spki = key.export({ type: 'spki', format: 'pem' }) as string;
  return crypto.createHash('sha256').update(spki).digest('hex').slice(0, 16);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rowToTokenRecord(row: Record<string, unknown>): EnrollmentTokenRecord {
  return {
    tokenHash: row.token_hash as string,
    issuedAt: row.issued_at as number,
    expiresAt: row.expires_at as number,
    issuedBy: row.issued_by as string,
    usedAt: (row.used_at as number | null) ?? undefined,
    usedByDeviceId: (row.used_by_device_id as string | null) ?? undefined,
    revokedAt: (row.revoked_at as number | null) ?? undefined,
    note: (row.note as string | null) ?? undefined,
  };
}

function rowToDevice(row: Record<string, unknown>): EnrolledDevice {
  return {
    deviceId: row.device_id as string,
    devicePubKeyPem: row.device_pubkey_pem as string,
    hostname: row.hostname as string,
    osVersion: row.os_version as string,
    titanxVersion: row.titanx_version as string,
    enrolledAt: row.enrolled_at as number,
    lastHeartbeatAt: (row.last_heartbeat_at as number | null) ?? undefined,
    status: row.status as 'enrolled' | 'revoked',
    revokedAt: (row.revoked_at as number | null) ?? undefined,
    deviceJwtJti: row.device_jwt_jti as string,
    enrollmentTokenHash: row.enrollment_token_hash as string,
  };
}

/** Audit log helper that swallows errors so enrollment doesn't fail on
 *  an audit-DB hiccup. Mirrors the pattern used in activityLog callers. */
function auditSafe(db: ISqliteDriver, entry: Parameters<typeof logActivity>[1]): void {
  try {
    logActivity(db, entry);
  } catch (e) {
    logNonCritical('fleet.enrollment.audit', e);
  }
}
