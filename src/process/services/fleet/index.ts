/**
 * @license Apache-2.0
 * Fleet service — owns the `fleet.*` ProcessConfig keys and the mode
 * lifecycle for v1.9.26+ (Phase A of the master/slave plan).
 *
 * Responsibilities:
 *   - Validated read / write of fleet mode + mode-specific config
 *   - Encryption of slave enrollment tokens via the secrets vault
 *     master key (never stored plaintext; never returned to renderer)
 *   - Audit log on mode changes + wizard completion
 *   - "Upgrade heuristic" — an install that already has other
 *     ProcessConfig keys set is treated as an existing user upgrading
 *     to v1.9.26, so the wizard is skipped and mode defaults to regular
 *
 * Design notes
 *   - Mode lives in ProcessConfig (file-based) rather than SQLite so the
 *     boot path can read it before DB migrations run
 *   - This service is intentionally independent of the DB for reads; the
 *     audit log writes are fire-and-forget via logNonCritical so the
 *     setup wizard works even if the DB is mid-migration
 *   - Phase B will add enrollment handshake + device JWT storage here
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { encrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { getDatabase } from '@process/services/database';
import * as activityLogService from '@process/services/activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getWebServerInstance, setWebServerInstance } from '@process/bridge/webuiBridge';
import { startWebServerWithInstance } from '@process/webserver/index';
import {
  isValidFleetMode,
  type FleetConfig,
  type FleetMode,
  type FleetSetupInput,
  type FleetSetupResult,
} from '@/common/types/fleetTypes';

// ── Defaults ────────────────────────────────────────────────────────────
const DEFAULT_MASTER_PORT = 8888;
const MIN_ENROLLMENT_TOKEN_LENGTH = 16;
const MASTER_URL_PATTERN = /^https?:\/\/\S+$/;

/**
 * Keys whose presence indicates this install existed BEFORE v1.9.26.
 * Upgrading users should skip the wizard and land in `regular` silently.
 * Chosen because these get written on first non-fleet user action.
 */
const UPGRADE_HEURISTIC_KEYS = [
  'system.closeToTray',
  'system.commandQueueEnabled',
  'system.notificationEnabled',
  'language',
  'theme',
  'model.config',
  'mcp.config',
] as const;

// ── Core reads ──────────────────────────────────────────────────────────

/** Current validated mode. Falls back to 'regular' if unset / invalid. */
export async function getFleetMode(): Promise<FleetMode> {
  const raw = await ProcessConfig.get('fleet.mode');
  return isValidFleetMode(raw) ? raw : 'regular';
}

/**
 * Full fleet config for renderer consumption. Never exposes the encrypted
 * enrollment token value — only whether one is stored.
 */
export async function getFleetConfig(): Promise<FleetConfig> {
  const mode = await getFleetMode();
  const setupCompletedAt = (await ProcessConfig.get('fleet.setupCompletedAt')) as number | undefined;

  const base: FleetConfig = { mode, setupCompletedAt };

  if (mode === 'master') {
    const port = ((await ProcessConfig.get('fleet.master.port')) as number | undefined) ?? DEFAULT_MASTER_PORT;
    const bindAll = ((await ProcessConfig.get('fleet.master.bindAll')) as boolean | undefined) ?? false;
    base.master = { port, bindAll };
  }

  if (mode === 'slave') {
    const masterUrl = (await ProcessConfig.get('fleet.slave.masterUrl')) as string | undefined;
    const ciphertext = (await ProcessConfig.get('fleet.slave.enrollmentTokenCiphertext')) as string | undefined;
    const enrollmentStatus =
      ((await ProcessConfig.get('fleet.slave.enrollmentStatus')) as 'pending' | 'enrolled' | 'revoked' | undefined) ??
      'pending';
    base.slave = {
      masterUrl,
      enrollmentStatus,
      hasPendingEnrollment: Boolean(masterUrl && ciphertext),
    };
  }

  return base;
}

/**
 * True when the setup wizard should open on next boot.
 *
 *   1. Feature flag must be enabled (caller checks this — this function
 *      trusts its caller; bridge layer consults securityFeaturesService)
 *   2. `fleet.mode` must be unset
 *   3. No pre-v1.9.26 config keys present (otherwise this is an upgrade,
 *      silently land in 'regular')
 */
export async function isSetupRequired(): Promise<boolean> {
  const existingMode = await ProcessConfig.get('fleet.mode');
  if (existingMode != null) return false;

  // If any pre-fleet key is set, this looks like an upgrade. Skip wizard
  // and seed 'regular' so the check stays idempotent.
  // Sequential-await is intentional: we short-circuit on the first hit,
  // so Promise.all would do more work than needed.
  for (const key of UPGRADE_HEURISTIC_KEYS) {
    // eslint-disable-next-line no-await-in-loop
    const value = await ProcessConfig.get(key);
    if (value != null) {
      // eslint-disable-next-line no-await-in-loop
      await ProcessConfig.set('fleet.mode', 'regular');
      return false;
    }
  }

  return true;
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * Validate a setup input. Returns null when valid, or an error message.
 * Kept pure so the wizard can call it before POSTing.
 */
export function validateFleetSetup(input: FleetSetupInput): string | null {
  if (!isValidFleetMode(input.mode)) {
    return `Invalid mode: ${String(input.mode)}`;
  }

  if (input.mode === 'master') {
    const port = input.masterPort ?? DEFAULT_MASTER_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return `Invalid master port: ${String(port)} (must be 1–65535)`;
    }
  }

  if (input.mode === 'slave') {
    // Both URL + token are optional at this stage — the wizard's
    // "I'll set up later" path goes through with neither. But IF url
    // is provided, it must be well-formed; if token is provided, it
    // must meet length requirements.
    if (input.slaveMasterUrl != null && input.slaveMasterUrl.length > 0) {
      if (!MASTER_URL_PATTERN.test(input.slaveMasterUrl)) {
        return `Invalid master URL: must be http:// or https://`;
      }
    }
    if (input.slaveEnrollmentToken != null && input.slaveEnrollmentToken.length > 0) {
      if (input.slaveEnrollmentToken.length < MIN_ENROLLMENT_TOKEN_LENGTH) {
        return `Enrollment token is too short (min ${String(MIN_ENROLLMENT_TOKEN_LENGTH)} chars)`;
      }
    }
  }

  return null;
}

/**
 * Apply a setup input: writes fleet.mode + mode-specific keys, encrypts
 * any provided enrollment token, writes an audit entry.
 *
 * Used by both the first-run wizard and the Settings mode-switcher.
 */
export async function applyFleetSetup(input: FleetSetupInput): Promise<FleetSetupResult> {
  const error = validateFleetSetup(input);
  if (error) return { ok: false, error };

  const priorMode = await getFleetMode();

  // Mode is always written first so subsequent reads see the new state.
  await ProcessConfig.set('fleet.mode', input.mode);

  if (input.mode === 'master') {
    const port = input.masterPort ?? DEFAULT_MASTER_PORT;
    const bindAll = input.masterBindAll ?? false;
    await ProcessConfig.set('fleet.master.port', port);
    await ProcessConfig.set('fleet.master.bindAll', bindAll);
  }

  if (input.mode === 'slave') {
    if (input.slaveMasterUrl && input.slaveMasterUrl.length > 0) {
      await ProcessConfig.set('fleet.slave.masterUrl', input.slaveMasterUrl);
    }
    if (input.slaveEnrollmentToken && input.slaveEnrollmentToken.length > 0) {
      // Encrypt with the secrets-vault master key; we persist only the
      // ciphertext JSON blob so Phase B can decrypt it for enrollment
      // without the renderer ever seeing plaintext.
      try {
        const masterKey = loadOrCreateMasterKey();
        const ciphertext = encrypt(input.slaveEnrollmentToken, masterKey);
        await ProcessConfig.set('fleet.slave.enrollmentTokenCiphertext', ciphertext);
      } catch (e) {
        logNonCritical('fleet.setup.encrypt-token', e);
        return { ok: false, error: 'Failed to encrypt enrollment token; please retry.' };
      }
    }
    await ProcessConfig.set('fleet.slave.enrollmentStatus', 'pending');
  }

  await ProcessConfig.set('fleet.setupCompletedAt', Date.now());

  void writeAuditEntry({
    priorMode,
    newMode: input.mode,
    hasEnrollment: Boolean(input.slaveMasterUrl || input.slaveEnrollmentToken),
  });

  // If we're switching TO master mode right now (not from boot), start
  // the webserver immediately so the user doesn't need to restart just
  // to see /api/fleet/* reachable. No-op if already running.
  if (input.mode === 'master' && priorMode !== 'master') {
    void startMasterWebServerIfConfigured();
  }

  return { ok: true };
}

/**
 * Convenience to reset to Regular — used when Cancel is clicked in the
 * wizard. Silently writes `fleet.mode = 'regular'` so the wizard never
 * shows again, but intentionally does NOT write `setupCompletedAt` so
 * the Fleet settings section can still show "Setup not complete".
 */
export async function applyWizardCancelled(): Promise<void> {
  await ProcessConfig.set('fleet.mode', 'regular');
  void writeAuditEntry({
    priorMode: 'regular',
    newMode: 'regular',
    hasEnrollment: false,
    cancelled: true,
  });
}

// ── Master-mode webserver auto-start (Phase C follow-up) ────────────────

/**
 * Start the webserver on `fleet.master.port` + `fleet.master.bindAll` if
 * this install is in master mode and the webserver isn't already running.
 *
 * This is the fix for a Phase A gap: the setup wizard persists the port
 * + bindAll preference, but nothing in the boot path actually starts
 * the server. The master wizard's promise ("Master TitanX exposes an
 * API so slave machines can connect") was cosmetic until this ran.
 *
 * Collision handling: if Desktop WebUI already bound a server at boot
 * (via `restoreDesktopWebUIFromPreferences`), we skip — the fleet
 * routes are registered on THE SAME Express app unconditionally, so
 * they're already reachable. Starting a second server would just fight
 * for the port.
 *
 * Silent no-op in regular / slave mode. Errors are logged but never
 * thrown — a master without a running API still boots, it just won't
 * accept slave connections until the user opens Settings and retries.
 */
export async function startMasterWebServerIfConfigured(): Promise<void> {
  const mode = await getFleetMode();
  if (mode !== 'master') return;

  // Desktop WebUI may have already started the server at boot; skip to
  // avoid a double-bind. The fleet routes are registered on the same
  // Express app, so the existing server already serves them.
  if (getWebServerInstance()) {
    console.log('[FleetMaster] Webserver already running (Desktop WebUI) — fleet routes active on that instance');
    return;
  }

  const port = ((await ProcessConfig.get('fleet.master.port')) as number | undefined) ?? DEFAULT_MASTER_PORT;
  const bindAll = ((await ProcessConfig.get('fleet.master.bindAll')) as boolean | undefined) ?? false;

  try {
    const instance = await startWebServerWithInstance(port, bindAll);
    setWebServerInstance(instance);
    console.log(
      `[FleetMaster] Webserver started on port=${String(instance.port)} bindAll=${String(bindAll)} — /api/fleet/* ready`
    );
  } catch (e) {
    logNonCritical('fleet.master.webserver-start', e);
    console.error('[FleetMaster] Failed to auto-start master webserver:', e);
  }
}

// ── Internals ───────────────────────────────────────────────────────────

type AuditInput = {
  priorMode: FleetMode;
  newMode: FleetMode;
  hasEnrollment: boolean;
  cancelled?: boolean;
};

async function writeAuditEntry(input: AuditInput): Promise<void> {
  try {
    const db = await getDatabase();
    activityLogService.logActivity(db.getDriver(), {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: 'fleet_setup',
      action: input.cancelled
        ? 'fleet.wizard.cancelled'
        : input.priorMode === input.newMode
          ? 'fleet.wizard.completed'
          : 'fleet.mode.changed',
      entityType: 'fleet',
      entityId: 'mode',
      details: {
        priorMode: input.priorMode,
        newMode: input.newMode,
        hasEnrollment: input.hasEnrollment,
      },
    });
  } catch (e) {
    logNonCritical('fleet.audit', e);
  }
}
