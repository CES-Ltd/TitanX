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

/**
 * Fleet role declared at enrollment time.
 *
 * Phase B v1.10.0 introduces two tiers:
 *   - 'workforce' (default): the original mode — slave is a managed
 *     employee endpoint receiving policies and templates.
 *   - 'farm': slave is a compute node exposing its local agent
 *     templates for remote execution via agent.execute. Masters can
 *     add farm agents to teams as if they were local.
 *
 * Role is locked at enroll time — re-enrollment is required to swap.
 * This keeps the audit trail clean and avoids a split-brain scenario
 * where master thinks a device is farm-capable but slave's local
 * ProcessConfig disagrees.
 */
export type FleetRole = 'workforce' | 'farm';

/** Input to enrollDevice() — the slave posts this over HTTPS. */
export type EnrollDeviceInput = {
  enrollmentToken: string;
  devicePubKeyPem: string;
  hostname: string;
  osVersion: string;
  titanxVersion: string;
  /**
   * Phase B v1.10.0: slave declares whether it's joining as a workforce
   * endpoint or a farm compute node. Optional for backward-compat —
   * pre-Phase-B slaves don't send this field and default to 'workforce'.
   */
  role?: FleetRole;
  /**
   * Phase B v1.10.0 — farm-capability hints (models the slave can run,
   * approximate concurrency). Opaque JSON for forward-compat. Only
   * consulted by the master's device-picker in the hire modal.
   */
  capabilities?: Record<string, unknown>;
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
