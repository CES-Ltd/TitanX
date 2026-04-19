/**
 * @license Apache-2.0
 * Phase C (v1.11.0) Dream Mode — slave-side learning push loop.
 *
 * Mirrors fleetTelemetry/slavePush.ts but with a 24h cadence and an
 * opt-in gate. Learnings are sensitive (trajectories + memory summaries
 * contain task output text), so the slave will NOT push until:
 *
 *   1. `fleet.mode === 'slave'` AND slave has a device JWT
 *   2. Master pushed a managed config with `fleet.learning.enabled = true`
 *      (stored in security_features / managed_config_keys)
 *
 * If either gate fails, the worker records the reason in the state
 * row and sleeps through the next cycle — no side effects.
 *
 * Env-var overrides (ops):
 *   - TITANX_LEARNING_PUSH_HOURS — integer hours between pushes
 *     (default 24). Setting to 1 is useful in dev/demo.
 *
 * Same discipline as telemetry:
 *   - In-flight guard coalesces timer + manual `pushNow()` calls
 *   - Cursor advances ONLY after 2xx from master
 *   - Errors record into the state row; don't throw up to caller
 *   - `__resetLearningPushForTests()` for suite isolation
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { decrypt, loadOrCreateMasterKey } from '@process/services/secrets/encryption';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getDatabase } from '@process/services/database';
import { buildLearningEnvelope, getLearningState, markEnvelopePushed, setLearningState } from './index';
import { LEARNING_PUSH_INTERVAL_MS, type LearningIngestResult, type LearningPushStatus } from './types';

const PUSH_INTERVAL_MS = resolveInterval();

function resolveInterval(): number {
  const envHours = process.env.TITANX_LEARNING_PUSH_HOURS;
  if (envHours) {
    const n = Number.parseInt(envHours, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 168) return n * 60 * 60 * 1000;
  }
  return LEARNING_PUSH_INTERVAL_MS;
}

let _pushTimer: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;
let _lastMasterUrl: string | undefined;

export async function getLearningPushStatus(): Promise<LearningPushStatus> {
  const running = _pushTimer != null;
  try {
    const db = await getDatabase();
    const state = getLearningState(db.getDriver());
    const enabled = await isLearningEnabledForDevice();
    // Error from the side table, if any.
    const { getLearningLastError } = await import('./index');
    const lastPushError = getLearningLastError(db.getDriver());
    return {
      running,
      lastPushAt: state.lastPushAt,
      lastWindowEnd: state.lastWindowEnd,
      lastPushError,
      enabled,
    };
  } catch (e) {
    logNonCritical('fleet.learning.status-read', e);
    return { running, enabled: false };
  }
}

/**
 * Start the push loop. Safe to call repeatedly. Fires one push pass
 * immediately on start so a slave that booted after an offline stretch
 * catches up without waiting a full 24h.
 */
export function startLearningPushLoop(masterUrl: string): void {
  _lastMasterUrl = masterUrl;
  if (_pushTimer) return;
  void pushOnce(masterUrl);
  _pushTimer = setInterval(() => void pushOnce(masterUrl), PUSH_INTERVAL_MS);
}

export function stopLearningPushLoop(): void {
  if (_pushTimer) {
    clearInterval(_pushTimer);
    _pushTimer = null;
  }
}

export function __resetLearningPushForTests(): void {
  stopLearningPushLoop();
  _inFlight = false;
  _lastMasterUrl = undefined;
}

/** Admin-triggered "Push now" from the renderer. */
export async function pushNow(): Promise<{ ok: boolean; error?: string }> {
  if (!_lastMasterUrl) {
    return { ok: false, error: 'slave is not running' };
  }
  await pushOnce(_lastMasterUrl);
  return { ok: true };
}

/**
 * One push pass. Five gates (each returns early on fail with a
 * recorded state row):
 *
 *   1. Opt-in gate — `fleet.learning.enabled` must be true
 *   2. JWT gate — device must be enrolled
 *   3. Window gate — skip zero-duration windows (spam protection)
 *   4. Empty-envelope gate — skip when no new learnings since last push
 *   5. Network gate — HTTP 2xx required to advance cursor
 */
export async function pushOnce(masterUrl: string): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    // Gate 1: opt-in. Covers both per-device disabled and global kill.
    const enabled = await isLearningEnabledForDevice();
    if (!enabled) {
      await recordError('learning export disabled by admin');
      return;
    }

    // Gate 2: device JWT present.
    const jwt = await getCachedDeviceJwt();
    if (!jwt) {
      await recordError('no device JWT cached — slave not enrolled yet');
      return;
    }

    const db = await getDatabase();
    const driver = db.getDriver();
    const state = getLearningState(driver);
    const windowStart = state.lastWindowEnd > 0 ? state.lastWindowEnd : 0;
    const windowEnd = Date.now();

    // Gate 3: zero-duration window.
    if (windowEnd <= windowStart) return;

    // Gate 4: empty envelope — still advance the cursor so future
    // pushes don't re-scan the same empty window.
    const envelope = buildLearningEnvelope(driver, windowStart, windowEnd);
    if (!envelope) {
      setLearningState(driver, {
        lastWindowEnd: windowEnd,
        lastPushAt: Date.now(),
        lastPushError: null,
      });
      return;
    }

    // Gate 5: master POST.
    const response = await fetch(`${stripTrailingSlash(masterUrl)}/api/fleet/learnings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ envelope }),
    });

    if (!response.ok) {
      await recordError(`learning push failed: HTTP ${String(response.status)}`);
      return;
    }

    const payload = (await response.json()) as Partial<LearningIngestResult>;
    if (payload.ok === false) {
      await recordError(`learning push rejected: ${payload.rejectedReason ?? 'unknown'}`);
      return;
    }
    const nextWindowStart = typeof payload.nextWindowStart === 'number' ? payload.nextWindowStart : windowEnd;

    // Record which rows were pushed so the next envelope skips them.
    markEnvelopePushed(driver, envelope);

    setLearningState(driver, {
      lastWindowEnd: nextWindowStart,
      lastPushAt: Date.now(),
      lastPushError: null,
    });
  } catch (e) {
    await recordError(e instanceof Error ? e.message : String(e));
    logNonCritical('fleet.learning.push', e);
  } finally {
    _inFlight = false;
  }
}

async function recordError(message: string): Promise<void> {
  try {
    const db = await getDatabase();
    setLearningState(db.getDriver(), { lastPushError: message });
  } catch (e) {
    logNonCritical('fleet.learning.record-error', e);
  }
}

/**
 * Opt-in check. Reads two signals:
 *
 *   1. `fleet.learning.globalDisabled` kill switch in ProcessConfig —
 *      overrides per-device state. Lets operators disable the entire
 *      feature locally without an admin-push cycle.
 *   2. `fleet.learning.enabled` managed config key from the latest
 *      master config bundle. Absent/false = opted out.
 */
async function isLearningEnabledForDevice(): Promise<boolean> {
  try {
    const kill = (await ProcessConfig.get('fleet.learning.globalDisabled')) as boolean | undefined;
    if (kill === true) return false;
  } catch {
    /* proceed to next check */
  }
  try {
    const db = await getDatabase();
    // v2.5.0 Phase A1 — default-on for fleet-enrolled slaves. The
    // learning push loop only starts AFTER successful enrollment
    // (fleetSlave/index.ts:118), so if we're running this gate we're
    // already a slave with a device JWT. Absent row = not explicitly
    // disabled by master = opt-in by default. An explicit row with
    // enabled=0 still wins (master can kill-switch per device via
    // the config bundle). The pre-v2.5 behavior (absent row = off)
    // meant the fleet never self-evolved out of the box — documented
    // gap in the dream-mode architecture review.
    const row = db
      .getDriver()
      .prepare(`SELECT enabled FROM security_features WHERE feature = 'fleet.learning.enabled' LIMIT 1`)
      .get() as { enabled: number } | undefined;
    if (!row) return true;
    return row.enabled === 1;
  } catch {
    // On any read failure, stay conservative and skip — next cycle
    // will retry the check.
    return false;
  }
}

async function getCachedDeviceJwt(): Promise<string | null> {
  const ciphertext = (await ProcessConfig.get('fleet.slave.deviceJwtCiphertext')) as string | undefined;
  if (!ciphertext || ciphertext.length === 0) return null;
  try {
    const key = loadOrCreateMasterKey();
    return decrypt(ciphertext, key);
  } catch (e) {
    logNonCritical('fleet.learning.decrypt-jwt', e);
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
