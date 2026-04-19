/**
 * @license Apache-2.0
 * Slave-side telemetry push loop (Phase D Week 2).
 *
 * Mirror image of fleetConfig/slaveSync.ts but pushing UP instead of
 * pulling DOWN. Every ~6 hours (configurable below) this loop:
 *
 *   1. Reads `last_report_window_end` from fleet_telemetry_state
 *   2. Builds a TelemetryReport for [lastWindowEnd, now)
 *   3. POSTs it to `<masterUrl>/api/fleet/telemetry` with the device JWT
 *   4. On 200 ok, advances `last_report_window_end = response.nextWindowStart`
 *   5. On any error, records `last_push_error` but leaves the cursor
 *      alone so the next push re-tries the same window
 *
 * Why 6h (not 30 s like config sync):
 *   - Telemetry aggregates are cumulative — admins don't need real-time
 *     cost dashboards, they look at "yesterday's fleet cost" once a day
 *   - A 6 h cadence × 1,000 slaves = ~4 POSTs/sec at the master, very
 *     cheap. Faster cadences would just burn battery on laptops.
 *   - The UI ships a "Push now" button (see `pushNow` export) for the
 *     rare "I need this right now" case
 *
 * Independence from config sync:
 *   Completely separate timer + in-flight guard from fleetConfig's
 *   slaveSync. A failing config poll does not block telemetry, and
 *   vice versa.
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getDatabase } from '@process/services/database';
import { buildTelemetryReport, getTelemetryState, setTelemetryState } from './index';
import type { IngestResult, TelemetryProviderInfo } from './types';
import type { IProvider } from '@/common/config/storage';

/** 6 hours — see module docstring for the sizing rationale. */
const PUSH_INTERVAL_MS = 6 * 60 * 60 * 1000;

let _pushTimer: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;
let _lastMasterUrl: string | undefined;

export type TelemetryPushStatus = {
  running: boolean;
  lastPushAt?: number;
  lastReportWindowEnd?: number;
  lastPushError?: string;
};

/**
 * Status getter that reads persisted push metadata from SQLite. Async
 * because `getDatabase()` is async; the IPC bridge awaits this directly.
 * (There's no synchronous variant — persisted state is the source of
 * truth and we don't want a sparse sync path racing against it.)
 */
export async function getTelemetryPushStatus(): Promise<TelemetryPushStatus> {
  const running = _pushTimer != null;
  try {
    const db = await getDatabase();
    const state = getTelemetryState(db.getDriver());
    return {
      running,
      lastPushAt: state.lastPushAt,
      lastReportWindowEnd: state.lastReportWindowEnd,
      lastPushError: state.lastPushError,
    };
  } catch (e) {
    logNonCritical('fleet.telemetry.status-read', e);
    return { running };
  }
}

/**
 * Start the push loop. Safe to call repeatedly. Fires one push
 * immediately so a slave that just booted after being offline for a
 * while catches up without waiting 6 hours.
 */
export function startTelemetryPushLoop(masterUrl: string): void {
  _lastMasterUrl = masterUrl;
  if (_pushTimer) return;
  void pushOnce(masterUrl);
  _pushTimer = setInterval(() => void pushOnce(masterUrl), PUSH_INTERVAL_MS);
}

export function stopTelemetryPushLoop(): void {
  if (_pushTimer) {
    clearInterval(_pushTimer);
    _pushTimer = null;
  }
}

/** Reset module-level state — TEST ONLY. */
export function __resetTelemetryPushForTests(): void {
  stopTelemetryPushLoop();
  _inFlight = false;
  _lastMasterUrl = undefined;
}

/**
 * User-triggered "Push now" — runs one push immediately against the
 * cached master URL. Returns { ok: false } when the loop isn't running
 * (wrong mode or not yet enrolled) so the UI can grey the button.
 */
export async function pushNow(): Promise<{ ok: boolean; error?: string }> {
  if (!_lastMasterUrl) {
    return { ok: false, error: 'slave is not running' };
  }
  await pushOnce(_lastMasterUrl);
  return { ok: true };
}

/**
 * One push pass. Coalesces concurrent callers via `_inFlight` so the
 * 6h timer + a "Push now" click don't race each other mid-flight.
 */
export async function pushOnce(masterUrl: string): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const jwt = await getCachedDeviceJwt();
    if (!jwt) {
      await recordError('no device JWT cached — slave not enrolled yet');
      return;
    }

    const db = await getDatabase();
    const state = getTelemetryState(db.getDriver());
    const windowStart = state.lastReportWindowEnd > 0 ? state.lastReportWindowEnd : 0;
    const windowEnd = Date.now();

    // Skip zero-duration windows — happens when pushNow() is spammed.
    if (windowEnd <= windowStart) {
      return;
    }

    // v2.2.0 — summarize local LLM providers so the master's hire-farm-agent
    // modal can warn before a turn gets dispatched that would just ack with
    // `no_provider_configured`. Summary is shape-only (no API keys).
    const providers = await summarizeLocalProviders();
    const report = buildTelemetryReport(db.getDriver(), windowStart, windowEnd, providers);

    const response = await fetch(`${stripTrailingSlash(masterUrl)}/api/fleet/telemetry`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ report }),
    });

    if (!response.ok) {
      await recordError(`telemetry push failed: HTTP ${String(response.status)}`);
      return;
    }

    const payload = (await response.json()) as Partial<IngestResult>;
    const nextWindowStart = typeof payload.nextWindowStart === 'number' ? payload.nextWindowStart : windowEnd;

    setTelemetryState(db.getDriver(), {
      lastReportWindowEnd: nextWindowStart,
      lastPushAt: Date.now(),
      lastPushError: undefined,
    });
  } catch (e) {
    await recordError(e instanceof Error ? e.message : String(e));
    logNonCritical('fleet.telemetry.push', e);
  } finally {
    _inFlight = false;
  }
}

async function recordError(message: string): Promise<void> {
  try {
    const db = await getDatabase();
    setTelemetryState(db.getDriver(), {
      lastPushError: message,
    });
  } catch (e) {
    logNonCritical('fleet.telemetry.record-error', e);
  }
}

async function getCachedDeviceJwt(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.deviceJwtCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.telemetry.decrypt-jwt', e);
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * v2.2.0 — summarize this slave's LLM providers from
 * `ProcessConfig('model.config')` into the shape the telemetry report
 * carries to master. NO secrets (`apiKey`, `bedrockConfig`, `baseUrl`,
 * `modelHealth` diagnostics) leave the slave — only identity, platform,
 * and enablement counts.
 *
 * Returns `undefined` on a read failure so the master distinguishes
 * "no providers" (zero-length array) from "couldn't determine"
 * (undefined → gating is disabled in the UI).
 */
async function summarizeLocalProviders(): Promise<TelemetryProviderInfo[] | undefined> {
  try {
    const raw = await ProcessConfig.get('model.config');
    if (!Array.isArray(raw)) return [];
    const providers = raw as IProvider[];
    return providers.map((p) => {
      const models = Array.isArray(p.model) ? p.model : [];
      const modelEnabled = p.modelEnabled ?? {};
      const enabledModelCount = models.reduce((acc, m) => {
        const on = modelEnabled[m];
        // Default is "enabled" when the map doesn't mention the model,
        // mirroring the convention in IProvider's JSDoc.
        return acc + (on === false ? 0 : 1);
      }, 0);
      return {
        id: p.id,
        platform: p.platform,
        name: p.name,
        enabled: p.enabled !== false,
        modelCount: models.length,
        enabledModelCount,
      };
    });
  } catch (e) {
    logNonCritical('fleet.telemetry.summarize-providers', e);
    return undefined;
  }
}
