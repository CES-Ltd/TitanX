/**
 * @license Apache-2.0
 * Fleet-mode types shared by process + renderer.
 *
 * TitanX v1.9.26+ supports three operating modes:
 *   - regular  — single-machine install (current behavior, the default).
 *   - master   — organization control plane. Owns Governance + Security
 *                + Agent Gallery defaults; aggregates cost telemetry
 *                from slaves. Same installer as Regular, different flag.
 *   - slave    — employee machine managed by an IT admin. Hides
 *                Governance / Observability / Deep Agent / Scheduled
 *                Tasks. Receives policies + gallery from a master in
 *                Phase B+ (not yet wired in v1.9.26).
 *
 * Phase A (v1.9.26) ships the mode plumbing + UI gating only. Actual
 * sync, enrollment, and device JWTs arrive in v1.9.27+ (Phase B).
 */

/** The three supported operating modes. Never extend without reviewing UI gating. */
export type FleetMode = 'regular' | 'master' | 'slave';

/**
 * Slave enrollment lifecycle (Phase A only tracks `pending`; Phase B adds
 * `enrolled` after successful handshake with master; Phase B also adds
 * `revoked` when master kicks the slave out of the fleet).
 */
export type SlaveEnrollmentStatus = 'pending' | 'enrolled' | 'revoked';

/**
 * Full fleet configuration, sourced from ProcessConfig keys under the
 * `fleet.*` namespace. Mode-specific fields are optional and only
 * populated for their respective modes.
 */
export type FleetConfig = {
  mode: FleetMode;
  /** Epoch ms when the setup wizard was last completed. Unset on first boot. */
  setupCompletedAt?: number;
  /** Master-mode network settings. Undefined in other modes. */
  master?: {
    /** Port the control-plane API binds to (default 8888, reuses existing webserver). */
    port: number;
    /** true = 0.0.0.0, false = 127.0.0.1 */
    bindAll: boolean;
  };
  /** Slave-mode connection details. Undefined in other modes. */
  slave?: {
    /** HTTPS URL of the master (e.g. "https://titanx.mycompany.lan:8888"). */
    masterUrl?: string;
    /** Enrollment status. Phase A always 'pending'. */
    enrollmentStatus: SlaveEnrollmentStatus;
    /**
     * Whether the user entered an enrollment token + URL during setup.
     * The token itself is NOT exposed to renderer — it stays encrypted
     * in the secrets vault on the process side. This flag just tells
     * the UI whether to show "enrollment pending" vs "set up later".
     */
    hasPendingEnrollment: boolean;
  };
};

/**
 * Input shape for the setup wizard's final commit + the Settings mode-switcher.
 * Mode-specific fields ignored when they don't apply.
 */
export type FleetSetupInput = {
  mode: FleetMode;
  /** Master-mode config (required when mode === 'master'). */
  masterPort?: number;
  masterBindAll?: boolean;
  /** Slave-mode config (optional even when mode === 'slave' — user may skip). */
  slaveMasterUrl?: string;
  slaveEnrollmentToken?: string;
};

/** Result of a setMode / completeSetup call. */
export type FleetSetupResult = { ok: true } | { ok: false; error: string };

/** True if the value is one of the three valid modes. */
export function isValidFleetMode(value: unknown): value is FleetMode {
  return value === 'regular' || value === 'master' || value === 'slave';
}
