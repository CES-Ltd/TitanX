/**
 * @license Apache-2.0
 * Destructive command handlers (Phase F.2 Week 3).
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
 */

import fs from 'fs/promises';
import path from 'path';
import { getSystemDir } from '@process/utils/initStorage';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

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

  return {
    status: 'succeeded',
    result: { scope, clearedPaths: cleared, skippedPaths: skipped },
  };
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
  const beforeRow = db
    .prepare("SELECT COUNT(*) as c FROM secrets WHERE user_id = 'system_default_user'")
    .get() as { c: number } | undefined;
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

  return {
    status: 'succeeded',
    result: { deletedSecrets: beforeCount },
  };
}
