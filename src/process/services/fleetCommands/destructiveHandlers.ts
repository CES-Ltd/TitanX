/**
 * @license Apache-2.0
 * Destructive command handlers (Phase F.2 Week 3, extended in Phase A v1.9.40).
 *
 * Runs AFTER the slave executor has already passed:
 *   1. Signature verification via fleetCommandSigning.verifyCommand
 *   2. Nonce replay guard via fleet_command_replay_nonces
 *
 * Meaning: by the time a handler here runs, we're certain the command
 * was minted by THIS master (not spoofed), it has not been replayed,
 * and the admin's re-auth gate on the enqueue side passed. The
 * handler can focus purely on "do the destructive thing correctly".
 *
 * Scope discipline: each handler is allow-listed on what it can touch.
 *   - cache.clear: ONLY {cacheDir}/temp + {cacheDir}/preview-history
 *     plus in-memory skills Map. Never workDir (user's workspace),
 *     never the top-level cacheDir itself, never secrets or DB.
 *   - credential.rotate: ONLY DELETE FROM secrets — the secret_versions
 *     table cascades. No fs work.
 *   - agent.restart (v1.9.40): dispose every active in-memory
 *     TeamSession. No DB mutation. Sessions lazy-rehydrate on the next
 *     user request.
 *   - force.upgrade (v1.9.40): delegate to autoUpdaterService —
 *     check → download → quit-and-install. Signature verification is
 *     owned by electron-updater's built-in publisher-pinned chain
 *     (Apple notarization + Microsoft Authenticode); the optional
 *     `sha256` param is recorded in the ack for audit only.
 */

import fs from 'fs/promises';
import path from 'path';
import { getSystemDir } from '@process/utils/initStorage';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getDatabase } from '../database';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { DestructiveCommandType } from '../fleetCommandSigning/types';

/**
 * v1.9.38: notify the slave's renderer when a destructive command
 * executes. The UI listens on `fleet:destructive-executed` and shows
 * an Arco Notification — gives the user a signal that their IT admin
 * just did something to their machine, instead of silent surprise.
 *
 * Dynamic import to avoid loading @/common (which pulls in Electron
 * IPC bindings) when this module is loaded during tests.
 *
 * Widened in v1.9.40 to cover agent.restart + force.upgrade.
 */
async function emitSlaveNotification(
  commandType: DestructiveCommandType,
  result: Record<string, unknown>
): Promise<void> {
  try {
    const { ipcBridge } = await import('@/common');
    ipcBridge.fleet.destructiveExecuted.emit({ commandType, result });
  } catch (e) {
    // Non-critical — the ack already landed; missed notification is UX
    // regression only, not a correctness issue.
    logNonCritical('fleet.command.destructive-notify', e);
  }
}

export type HandlerOutcome = {
  status: 'succeeded' | 'failed' | 'skipped';
  result?: Record<string, unknown>;
};

// ── cache.clear ─────────────────────────────────────────────────────────

type CacheScope = 'temp_files' | 'model_cache' | 'skill_cache' | 'all';

const VALID_SCOPES: ReadonlySet<CacheScope> = new Set(['temp_files', 'model_cache', 'skill_cache', 'all']);

/**
 * Clear scoped cache paths. Validates the scope against a fixed
 * allow-list FIRST — a malformed param from master (or a future
 * command-type we don't yet handle) fails closed with 'skipped',
 * never 'failed' (which would imply a retry is useful).
 */
export async function handleCacheClear(params: Record<string, unknown>): Promise<HandlerOutcome> {
  const scope = params.scope as CacheScope | undefined;
  if (!scope || !VALID_SCOPES.has(scope)) {
    return {
      status: 'skipped',
      result: { reason: 'invalid_scope', scope: String(scope ?? '<undefined>') },
    };
  }

  const { cacheDir } = getSystemDir();
  if (!cacheDir) {
    return { status: 'failed', result: { error: 'cacheDir not resolvable' } };
  }

  // Build the allow-list of paths we'll touch, per-scope. Keeping this
  // explicit makes audit clearer than a "union of everything" approach.
  const paths: string[] = [];
  if (scope === 'temp_files' || scope === 'all') {
    paths.push(path.join(cacheDir, 'temp'));
  }
  if (scope === 'model_cache' || scope === 'all') {
    paths.push(path.join(cacheDir, 'preview-history'));
  }
  // NOTE: 'skill_cache' is an in-memory Map — see clearSkillsInMemoryCache
  // below. The on-disk `builtin-skills/` and `skills/` directories hold
  // SOURCE, not cache output, and must NEVER be deleted here.

  // Defensive path check — refuse to rm the top-level cacheDir or
  // anything outside it. A malicious (or buggy) master can't coerce us
  // into deleting the user's workspace.
  const cleared: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const p of paths) {
    if (p === cacheDir || !p.startsWith(cacheDir + path.sep)) {
      skipped.push({ path: p, reason: 'outside_cacheDir' });
      continue;
    }
    try {
      await fs.rm(p, { recursive: true, force: true });
      cleared.push(p);
    } catch (e) {
      skipped.push({ path: p, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // In-memory skills cache is cleared for 'skill_cache' and 'all'.
  // Dynamic import is intentional — initStorage has heavy dependencies
  // and we don't want them loaded until the command actually fires.
  if (scope === 'skill_cache' || scope === 'all') {
    try {
      const { clearSkillsCache } = (await import('@process/utils/initStorage')) as {
        clearSkillsCache?: () => void;
      };
      if (typeof clearSkillsCache === 'function') {
        clearSkillsCache();
        cleared.push('in-memory:skillsContentCache');
      }
    } catch (e) {
      skipped.push({ path: 'in-memory:skillsContentCache', reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const outcome: HandlerOutcome = {
    status: 'succeeded',
    result: { scope, clearedPaths: cleared, skippedPaths: skipped },
  };
  void emitSlaveNotification('cache.clear', outcome.result ?? {});
  return outcome;
}

// ── credential.rotate ───────────────────────────────────────────────────

/**
 * Clear every saved credential for the default user. Cascading FK on
 * secret_versions means one DELETE covers both tables. Also revokes
 * every agent's access tokens (credential_access_tokens has an
 * ON DELETE CASCADE to secrets).
 *
 * After this runs, the user is prompted to re-enter provider keys on
 * next model invocation. That's the feature, not a bug.
 */
export async function handleCredentialRotate(db: ISqliteDriver): Promise<HandlerOutcome> {
  // Count first so the ack tells the admin how many secrets got wiped
  const beforeRow = db.prepare("SELECT COUNT(*) as c FROM secrets WHERE user_id = 'system_default_user'").get() as
    | { c: number }
    | undefined;
  const beforeCount = beforeRow?.c ?? 0;

  try {
    db.prepare("DELETE FROM secrets WHERE user_id = 'system_default_user'").run();
  } catch (e) {
    return {
      status: 'failed',
      result: { error: e instanceof Error ? e.message : String(e), beforeCount },
    };
  }

  // Audit the rotation as a destructive operation so the record
  // survives even if the caller's audit chain has a hiccup.
  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_destructive_handler',
      action: 'fleet.command.credential_rotated',
      entityType: 'fleet_command',
      entityId: 'credential.rotate',
      details: { deletedSecrets: beforeCount },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-credential-rotate', e);
  }

  const outcome: HandlerOutcome = {
    status: 'succeeded',
    result: { deletedSecrets: beforeCount },
  };
  void emitSlaveNotification('credential.rotate', outcome.result ?? {});
  return outcome;
}

// ── agent.restart (Phase A v1.9.40) ─────────────────────────────────────

/**
 * Tear down every live TeamSession on this slave.
 *
 * No DB mutation, no conversation deletion — pure in-memory state
 * clear. The next user interaction that would normally go through
 * `getOrStartSession(teamId)` will rehydrate the session from disk via
 * the existing bootstrap path, so users see no data loss.
 *
 * Why this is destructive-signed anyway: tearing down an active wake
 * interrupts any in-flight turn on this device, so a malicious master
 * could use it to stall a slave's workflow. Requires the same Ed25519
 * signature + admin re-auth gate as the other destructive types so
 * admins can't accidentally fire it without confirming intent.
 *
 * The teamBridge accessor (getTeamSessionService) returns null early
 * in boot or in headless/test contexts — handler skips in that case
 * with a stable reason code so the admin dashboard surfaces why.
 */
export async function handleAgentRestart(): Promise<HandlerOutcome> {
  let svc: { stopAllSessions(): Promise<void>; getActiveSessionCount(): number } | null = null;
  try {
    const { getTeamSessionService } = await import('@process/bridge/teamBridge');
    svc = getTeamSessionService();
  } catch (e) {
    // Bridge isn't loadable in this process context (e.g. during a
    // headless test harness). Not a hard failure — skip so the admin
    // sees the reason instead of a spurious 'failed' retry-hint.
    logNonCritical('fleet.command.agent-restart-bridge-load', e);
    return { status: 'skipped', result: { reason: 'team_service_unavailable' } };
  }
  if (!svc) {
    return { status: 'skipped', result: { reason: 'team_service_unavailable' } };
  }

  const restartedSessions = svc.getActiveSessionCount();
  try {
    await svc.stopAllSessions();
  } catch (e) {
    return {
      status: 'failed',
      result: {
        error: e instanceof Error ? e.message : String(e),
        restartedSessions,
      },
    };
  }

  try {
    const db = await getDatabase();
    logActivity(db.getDriver(), {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_destructive_handler',
      action: 'fleet.command.agent_restarted',
      entityType: 'fleet_command',
      entityId: 'agent.restart',
      details: { restartedSessions },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-agent-restart', e);
  }

  const outcome: HandlerOutcome = {
    status: 'succeeded',
    result: { restartedSessions },
  };
  void emitSlaveNotification('agent.restart', outcome.result ?? {});
  return outcome;
}

// ── force.upgrade (Phase A v1.9.40) ─────────────────────────────────────

/**
 * Trigger a check-download-quit-install sequence through the existing
 * autoUpdaterService. Four outcomes:
 *
 *   1. updater uninitialized (dev mode, tests) → 'skipped'
 *   2. check fails (network, API)              → 'failed'
 *   3. no update available                     → 'succeeded'
 *      with { reason: 'no_update_available', currentVersion }
 *   4. update available + downloaded           → 'succeeded'
 *      with { willQuitIn: '3s', newVersion }; a delayed quitAndInstall
 *      fires AFTER postAck so the master gets confirmation before the
 *      app dies.
 *
 * The optional `sha256` param is recorded in the ack for audit/forensics
 * but not enforced — electron-updater's built-in publisher-signature
 * chain is the actual integrity gate and is much stronger than a
 * self-reported hash. If that chain is ever weakened, we'd add a proper
 * hash-match step here; for now recording the expected hash is enough
 * to detect accidental release-name drift on the master side.
 */
export async function handleForceUpgrade(params: Record<string, unknown>): Promise<HandlerOutcome> {
  let autoUpdaterService: {
    isInitialized: boolean;
    checkForUpdates(): Promise<{ success: boolean; updateInfo?: { version: string }; error?: string }>;
    downloadUpdate(): Promise<{ success: boolean; error?: string }>;
    quitAndInstall(): void;
  };
  try {
    const mod = await import('../autoUpdaterService');
    autoUpdaterService = mod.autoUpdaterService;
  } catch (e) {
    logNonCritical('fleet.command.force-upgrade-import', e);
    return { status: 'skipped', result: { reason: 'auto_updater_unavailable' } };
  }

  if (!autoUpdaterService.isInitialized) {
    return { status: 'skipped', result: { reason: 'auto_updater_uninitialized' } };
  }

  const expectedSha256 = typeof params.sha256 === 'string' && params.sha256.length > 0 ? params.sha256 : undefined;

  const checkResult = await autoUpdaterService.checkForUpdates();
  if (!checkResult.success) {
    return {
      status: 'failed',
      result: { error: checkResult.error ?? 'check failed', expectedSha256 },
    };
  }
  if (!checkResult.updateInfo) {
    return {
      status: 'succeeded',
      result: { reason: 'no_update_available', expectedSha256 },
    };
  }

  const newVersion = checkResult.updateInfo.version;

  const downloadResult = await autoUpdaterService.downloadUpdate();
  if (!downloadResult.success) {
    return {
      status: 'failed',
      result: { error: downloadResult.error ?? 'download failed', newVersion, expectedSha256 },
    };
  }

  // Audit BEFORE scheduling the quit so the record survives even if
  // quitAndInstall races with a slow DB write.
  try {
    const db = await getDatabase();
    logActivity(db.getDriver(), {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_destructive_handler',
      action: 'fleet.command.force_upgrade_triggered',
      entityType: 'fleet_command',
      entityId: 'force.upgrade',
      details: { newVersion, expectedSha256 },
    });
  } catch (e) {
    logNonCritical('fleet.command.audit-force-upgrade', e);
  }

  const outcome: HandlerOutcome = {
    status: 'succeeded',
    result: { newVersion, expectedSha256, willQuitIn: '3s' },
  };
  void emitSlaveNotification('force.upgrade', outcome.result ?? {});

  // Fire-and-forget quitAndInstall on a short delay so the outer
  // slaveExecutor has time to POST the ack before the process dies.
  // 3s is empirically enough for the ack HTTP round-trip (< 500 ms on
  // localhost, < 2 s across the open internet with TLS cold-start) with
  // comfortable headroom.
  setTimeout(() => {
    try {
      autoUpdaterService.quitAndInstall();
    } catch (e) {
      logNonCritical('fleet.command.quitAndInstall', e);
    }
  }, 3000);

  return outcome;
}
