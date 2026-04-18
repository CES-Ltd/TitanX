/**
 * @license Apache-2.0
 * Shared types for the fleet enrollment service (Phase B).
 *
 * Kept in its own file so both the service and the HTTP router (Phase B
 * Week 2 / Phase C) can import without a cycle.
 */

/** Lifecycle of an enrolled slave. */
export type EnrollmentStatus = 'enrolled' | 'revoked';

/** A one-time enrollment token record (plaintext only known at issue time). */
export type EnrollmentTokenRecord = {
  /** SHA256(token) — plaintext is never stored. */
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  issuedBy: string;
  usedAt?: number;
  usedByDeviceId?: string;
  revokedAt?: number;
  /** Free-form label (e.g. "engineering laptops batch 1"). */
  note?: string;
};

/** A row in the device roster. */
export type EnrolledDevice = {
  deviceId: string;
  devicePubKeyPem: string;
  hostname: string;
  osVersion: string;
  titanxVersion: string;
  enrolledAt: number;
  lastHeartbeatAt?: number;
  status: EnrollmentStatus;
  revokedAt?: number;
  /** Current JWT identifier; rotates on re-enrollment. */
  deviceJwtJti: string;
  /** SHA256 of the enrollment token this device consumed. */
  enrollmentTokenHash: string;
};

/** Public shape returned from `generateEnrollmentToken`. */
export type GeneratedEnrollmentToken = {
  /** Plaintext — shown to admin ONCE, never persisted. */
  token: string;
  tokenHash: string;
  expiresAt: number;
};

/** Input to enrollDevice() — the slave posts this over HTTPS. */
export type EnrollDeviceInput = {
  enrollmentToken: string;
  devicePubKeyPem: string;
  hostname: string;
  osVersion: string;
  titanxVersion: string;
};

/** Success result from enrollDevice() — returned to the slave. */
export type EnrollDeviceSuccess = {
  ok: true;
  deviceId: string;
  /** Signed JWT the slave stores and presents on subsequent requests. */
  deviceJwt: string;
  /** Epoch ms — when the slave should start trying to refresh. */
  jwtExpiresAt: number;
  /**
   * Phase F.2: master's Ed25519 public key in PEM, used by the slave
   * to verify signed destructive commands (cache.clear,
   * credential.rotate). Slaves store this encrypted alongside the
   * device JWT. Optional on wire so pre-F.2 masters remain
   * compatible — a slave receiving an undefined pubkey simply
   * refuses every destructive command with reason='no_pubkey'.
   */
  masterCommandSigningPubKey?: string;
};

/** Failure result from enrollDevice() with a human-readable reason. */
export type EnrollDeviceFailure = { ok: false; error: string };

export type EnrollDeviceResult = EnrollDeviceSuccess | EnrollDeviceFailure;

/** Claims embedded in the device JWT. */
export type DeviceJwtClaims = {
  /** Device ID (SHA256 fingerprint of the Ed25519 pubkey). */
  sub: string;
  iat: number;
  exp: number;
  /** Per-enrollment JWT ID; changes on revoke/re-enroll. */
  jti: string;
  /** Fixed string so we can distinguish device JWTs from user JWTs. */
  typ: 'device';
};
