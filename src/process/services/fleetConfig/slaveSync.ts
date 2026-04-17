/**
 * @license Apache-2.0
 * Slave-side config sync poller (Phase C Week 2).
 *
 * Polls `GET /api/fleet/config?since=<localVersion>` every 30 seconds
 * while the slave is enrolled + online. When master returns a non-`upToDate`
 * bundle, `applyConfigBundle` replaces the slave's master-managed IAM
 * policies + feature toggles and registers the managed keys so the UI
 * can render lock icons.
 *
 * Why not WS push?
 *   The existing WebSocketManager auths via user JWT (for the desktop UI's
 *   live-events channel), not device JWT. Adding a device-JWT channel
 *   would cross-cut through auth middleware + token verification for a
 *   marginal latency win — polling at 30 s is already well within "config
 *   change shows up in under a minute" UX expectations. If we ever need
 *   sub-second sync we can add WS later behind this same apply step.
 *
 * Coupling to fleetSlave:
 *   This module has NO direct dependency on fleetSlave — it reads master
 *   URL + device JWT from ProcessConfig on its own. That keeps the two
 *   loops independent: heartbeat can fail / slave go offline, and config
 *   poll just silently skips until connectivity returns.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getDatabase } from '@process/services/database';
import { broadcastToAll } from '@/common/adapter/registry';
import { applyConfigBundle, getConfigVersion } from './index';
import type { ApplyBundleResult, FleetConfigBundle } from './types';

const POLL_INTERVAL_MS = 30_000;

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _lastPollAt: number | undefined;
let _lastAppliedVersion: number | undefined;
let _lastErrorMessage: string | undefined;
let _inFlight = false;
let _appliedListeners: Array<(r: ApplyBundleResult) => void> = [];

/**
 * Subscribe to successful-apply events. Returns an unsubscribe function.
 * The fleetBridge uses this to re-emit over IPC for the desktop renderer
 * (web dashboard already receives the WS broadcast below).
 */
export function onConfigApplied(listener: (r: ApplyBundleResult) => void): () => void {
  _appliedListeners.push(listener);
  return () => {
    _appliedListeners = _appliedListeners.filter((l) => l !== listener);
  };
}

export type ConfigSyncStatus = {
  running: boolean;
  lastPollAt?: number;
  lastAppliedVersion?: number;
  lastErrorMessage?: string;
};

export function getConfigSyncStatus(): ConfigSyncStatus {
  return {
    running: _pollTimer != null,
    lastPollAt: _lastPollAt,
    lastAppliedVersion: _lastAppliedVersion,
    lastErrorMessage: _lastErrorMessage,
  };
}

/**
 * Start the poll loop. Safe to call repeatedly — second call is a no-op
 * if the loop is already running. Fires one poll immediately so the slave
 * picks up the current master state without waiting the first interval.
 */
export function startConfigSyncPoller(masterUrl: string): void {
  if (_pollTimer) return;
  void pollOnce(masterUrl);
  _pollTimer = setInterval(() => void pollOnce(masterUrl), POLL_INTERVAL_MS);
}

/** Stop the poll loop. Called on mode-change + shutdown. */
export function stopConfigSyncPoller(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

/** Reset module-level state — TEST ONLY. */
export function __resetConfigSyncForTests(): void {
  stopConfigSyncPoller();
  _lastPollAt = undefined;
  _lastAppliedVersion = undefined;
  _lastErrorMessage = undefined;
  _inFlight = false;
  _appliedListeners = [];
}

/**
 * Do one poll pass. Exported for test harness + manual "Sync Now" button.
 * Skips if a previous poll is still in flight (prevents pile-up if the
 * master is slow). Errors never throw — they're recorded in the status
 * struct + logged non-critical so the caller can treat this as
 * fire-and-forget.
 */
export async function pollOnce(masterUrl: string): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const jwt = await getCachedDeviceJwt();
    if (!jwt) {
      _lastErrorMessage = 'no device JWT cached — slave not enrolled yet';
      return;
    }

    const db = await getDatabase();
    const sinceVersion = getConfigVersion(db.getDriver());

    const url = `${stripTrailingSlash(masterUrl)}/api/fleet/config?since=${String(sinceVersion)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${jwt}` },
    });

    _lastPollAt = Date.now();

    if (!response.ok) {
      // 401 = token expired / device revoked — the heartbeat loop will
      // catch this and flip status → revoked. Here we just record + skip.
      _lastErrorMessage = `config poll failed: HTTP ${String(response.status)}`;
      return;
    }

    const payload = (await response.json()) as { bundle?: FleetConfigBundle };
    const bundle = payload.bundle;
    if (!bundle) {
      _lastErrorMessage = 'master returned no bundle';
      return;
    }

    if (bundle.upToDate) {
      _lastErrorMessage = undefined;
      _lastAppliedVersion = sinceVersion;
      return;
    }

    const result = applyConfigBundle(db.getDriver(), bundle);
    _lastAppliedVersion = result.version;
    _lastErrorMessage = undefined;

    // Two notification paths on apply success:
    //   (a) WS broadcast for any web-dashboard clients connected via the
    //       main webserver — they get a live event they can handle.
    //   (b) `onConfigApplied` listener for the desktop IPC bridge — the
    //       fleetBridge re-emits this as `fleet:config-applied` so the
    //       renderer refreshes IAM / feature-toggle caches.
    try {
      broadcastToAll('fleet.config.applied', {
        version: result.version,
        iamPoliciesReplaced: result.iamPoliciesReplaced,
        securityFeaturesUpdated: result.securityFeaturesUpdated,
        newlyManagedKeys: result.newlyManagedKeys,
      });
    } catch (e) {
      logNonCritical('fleet.config.broadcast-applied', e);
    }
    for (const listener of _appliedListeners) {
      try {
        listener(result);
      } catch (e) {
        logNonCritical('fleet.config.applied-listener', e);
      }
    }
  } catch (e) {
    _lastErrorMessage = e instanceof Error ? e.message : String(e);
    logNonCritical('fleet.config.poll', e);
  } finally {
    _inFlight = false;
  }
}

// ── helpers (mirror fleetSlave) ─────────────────────────────────────────

async function getCachedDeviceJwt(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.deviceJwtCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.config.decrypt-jwt', e);
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
