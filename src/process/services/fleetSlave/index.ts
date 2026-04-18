/**
 * @license Apache-2.0
 * Slave-side fleet client (Phase B Week 2).
 *
 * Responsibilities:
 *   1. Boot-time enrollment — if fleet mode is 'slave' AND no device
 *      JWT is cached locally, call master's /api/fleet/enroll with the
 *      enrollment token + local Ed25519 pubkey. Store the returned JWT
 *      encrypted at rest in ProcessConfig.
 *   2. Heartbeat loop — while enrolled, POST /api/fleet/heartbeat every
 *      60s with Authorization: Bearer <jwt>. Detects revocation via 401
 *      and flips local enrollmentStatus to 'revoked'.
 *   3. Status broadcasting — expose enrollmentStatus + lastSyncAt for
 *      the renderer UI (offline banner, settings display).
 *
 * Design choices
 *   - Runs only when fleet.mode === 'slave'. Silent no-op otherwise so
 *     Regular/Master installs don't make surprise outbound calls.
 *   - Network failures (master unreachable) do NOT flip status — they
 *     just skip that heartbeat. Slaves work offline with cached config.
 *   - 401 from heartbeat DOES flip status → 'revoked' so the UI can
 *     show "removed by IT admin" and stop retrying.
 *   - Exponential backoff on enrollment failures (max 10 min between
 *     retries) so a temporarily-unreachable master doesn't spin.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { getDeviceId, getDevicePublicKey } from '@process/services/deviceIdentity';
import { encrypt, decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { logNonCritical } from '@process/utils/logNonCritical';
import { startConfigSyncPoller, stopConfigSyncPoller } from '@process/services/fleetConfig/slaveSync';
import { startTelemetryPushLoop, stopTelemetryPushLoop } from '@process/services/fleetTelemetry/slavePush';
import os from 'os';

/** Read app version from Electron's `app` when available; fall back to
 *  package.json for tests. Never throws. */
function getAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app?: { getVersion?: () => string } };
    const v = app?.getVersion?.();
    if (typeof v === 'string' && v.length > 0) return v;
  } catch {
    /* not in electron context — test harness, fall through */
  }
  return 'unknown';
}

const HEARTBEAT_INTERVAL_MS = 60_000;
const ENROLLMENT_RETRY_BASE_MS = 30_000;
const ENROLLMENT_RETRY_MAX_MS = 10 * 60_000;

type ConnectionStatus = 'offline' | 'online' | 'revoked' | 'unenrolled';

export type SlaveStatus = {
  mode: 'slave';
  connection: ConnectionStatus;
  deviceId?: string;
  lastHeartbeatAt?: number;
  lastErrorMessage?: string;
};

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let _enrollmentBackoffMs = ENROLLMENT_RETRY_BASE_MS;
let _currentStatus: SlaveStatus = { mode: 'slave', connection: 'offline' };
let _statusListeners: Array<(s: SlaveStatus) => void> = [];

/** Subscribe to slave-status changes — returns an unsubscribe function. */
export function onSlaveStatusChanged(listener: (s: SlaveStatus) => void): () => void {
  _statusListeners.push(listener);
  return () => {
    _statusListeners = _statusListeners.filter((l) => l !== listener);
  };
}

export function getSlaveStatus(): SlaveStatus {
  return _currentStatus;
}

function updateStatus(patch: Partial<SlaveStatus>): void {
  _currentStatus = { ..._currentStatus, ...patch };
  for (const listener of _statusListeners) {
    try {
      listener(_currentStatus);
    } catch (e) {
      logNonCritical('fleet.slave.status-listener', e);
    }
  }
}

// ── Public lifecycle ────────────────────────────────────────────────────

/**
 * Boot-time entry point. Called from app startup after ProcessConfig is
 * loaded + mode is determined. No-op when mode !== 'slave'.
 */
export async function startSlaveIfEnrolled(): Promise<void> {
  const mode = await ProcessConfig.get('fleet.mode');
  if (mode !== 'slave') return;

  const masterUrl = (await ProcessConfig.get('fleet.slave.masterUrl')) as string | undefined;
  if (!masterUrl) {
    // Wizard skipped URL setup — stay in 'unenrolled' until user completes it
    updateStatus({ connection: 'unenrolled' });
    return;
  }

  const existingJwt = await getCachedDeviceJwt();
  if (existingJwt) {
    // Already enrolled — jump straight to heartbeat + config-sync +
    // telemetry-push loops.
    updateStatus({ connection: 'online', deviceId: getDeviceId() });
    startHeartbeatLoop(masterUrl);
    startConfigSyncPoller(masterUrl);
    startTelemetryPushLoop(masterUrl);
    return;
  }

  // Need to enroll — kick off the handshake
  void attemptEnrollment(masterUrl);
}

/** Stop all timers. Called at app shutdown. */
export function stopSlaveClient(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  _enrollmentBackoffMs = ENROLLMENT_RETRY_BASE_MS;
  stopConfigSyncPoller();
  stopTelemetryPushLoop();
}

/** Reset all module-level state — TEST ONLY. Production code never needs this. */
export function __resetSlaveClientForTests(): void {
  stopSlaveClient();
  _currentStatus = { mode: 'slave', connection: 'offline' };
  _statusListeners = [];
}

// ── Enrollment ──────────────────────────────────────────────────────────

async function attemptEnrollment(masterUrl: string): Promise<void> {
  const token = await decryptStoredEnrollmentToken();
  if (!token) {
    updateStatus({ connection: 'unenrolled', lastErrorMessage: 'no enrollment token stored' });
    return;
  }

  try {
    const response = await fetch(`${stripTrailingSlash(masterUrl)}/api/fleet/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollmentToken: token,
        devicePubKeyPem: getDevicePublicKey(),
        hostname: os.hostname(),
        osVersion: `${os.platform()} ${os.release()}`,
        titanxVersion: getAppVersion(),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      updateStatus({
        connection: 'unenrolled',
        lastErrorMessage: body.error ?? `enrollment failed: HTTP ${String(response.status)}`,
      });
      scheduleEnrollmentRetry(masterUrl);
      return;
    }

    const data = (await response.json()) as { deviceJwt: string; deviceId: string; jwtExpiresAt: number };
    await persistDeviceJwt(data.deviceJwt);
    await ProcessConfig.set('fleet.slave.enrollmentStatus', 'enrolled');
    // Token is now consumed — clear the stored ciphertext so it's not reusable.
    await ProcessConfig.set('fleet.slave.enrollmentTokenCiphertext', '');
    _enrollmentBackoffMs = ENROLLMENT_RETRY_BASE_MS;
    updateStatus({
      connection: 'online',
      deviceId: data.deviceId,
      lastErrorMessage: undefined,
    });
    startHeartbeatLoop(masterUrl);
    startConfigSyncPoller(masterUrl);
    startTelemetryPushLoop(masterUrl);
    console.log('[FleetSlave] Enrollment successful. Heartbeat + config-sync + telemetry-push loops started.');
  } catch (e) {
    logNonCritical('fleet.slave.enroll', e);
    updateStatus({
      connection: 'offline',
      lastErrorMessage: e instanceof Error ? e.message : String(e),
    });
    scheduleEnrollmentRetry(masterUrl);
  }
}

function scheduleEnrollmentRetry(masterUrl: string): void {
  const delayMs = Math.min(_enrollmentBackoffMs, ENROLLMENT_RETRY_MAX_MS);
  _enrollmentBackoffMs = Math.min(_enrollmentBackoffMs * 2, ENROLLMENT_RETRY_MAX_MS);
  setTimeout(() => void attemptEnrollment(masterUrl), delayMs);
}

// ── Heartbeat loop ──────────────────────────────────────────────────────

function startHeartbeatLoop(masterUrl: string): void {
  if (_heartbeatTimer) return;
  // Fire one immediately so the status flips to 'online' fast, then interval.
  void heartbeatOnce(masterUrl);
  _heartbeatTimer = setInterval(() => void heartbeatOnce(masterUrl), HEARTBEAT_INTERVAL_MS);
}

async function heartbeatOnce(masterUrl: string): Promise<void> {
  const jwt = await getCachedDeviceJwt();
  if (!jwt) {
    // Lost our JWT — re-enroll
    stopSlaveClient();
    void attemptEnrollment(masterUrl);
    return;
  }

  try {
    const response = await fetch(`${stripTrailingSlash(masterUrl)}/api/fleet/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
    });

    if (response.status === 401) {
      // JWT invalid / superseded / master rotated keys — status is now unknown.
      // Flip to revoked; operator can unenroll + re-enroll.
      await ProcessConfig.set('fleet.slave.enrollmentStatus', 'revoked');
      updateStatus({ connection: 'revoked', lastErrorMessage: 'master rejected device token' });
      stopSlaveClient();
      return;
    }

    if (response.status === 410) {
      // Device was revoked cleanly on master side.
      await ProcessConfig.set('fleet.slave.enrollmentStatus', 'revoked');
      updateStatus({ connection: 'revoked', lastErrorMessage: 'device revoked by admin' });
      stopSlaveClient();
      return;
    }

    if (!response.ok) {
      updateStatus({
        connection: 'offline',
        lastErrorMessage: `heartbeat failed: HTTP ${String(response.status)}`,
      });
      return;
    }

    updateStatus({
      connection: 'online',
      lastHeartbeatAt: Date.now(),
      lastErrorMessage: undefined,
    });
  } catch (e) {
    // Network failure → offline but DON'T flip enrolled status — slave is
    // still enrolled, just can't reach master right now.
    updateStatus({
      connection: 'offline',
      lastErrorMessage: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Secrets-vault storage helpers ───────────────────────────────────────

/** Decrypt the enrollment token captured by the wizard (if any). */
async function decryptStoredEnrollmentToken(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.enrollmentTokenCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.slave.decrypt-token', e);
    return null;
  }
}

/** Persist the device JWT encrypted at rest. */
async function persistDeviceJwt(jwt: string): Promise<void> {
  const key = loadOrCreateMasterKey();
  const ciphertext = encrypt(jwt, key);
  await ProcessConfig.set('fleet.slave.deviceJwtCiphertext', ciphertext);
}

/** Read + decrypt the cached device JWT, if any. */
async function getCachedDeviceJwt(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.deviceJwtCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.slave.decrypt-jwt', e);
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
