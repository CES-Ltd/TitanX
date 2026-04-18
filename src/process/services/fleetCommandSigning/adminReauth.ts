/**
 * @license Apache-2.0
 * Admin re-auth gate for destructive commands (Phase F.2 Week 2).
 *
 * Before a destructive command is enqueued, the admin re-types their
 * password. The renderer passes `{ confirmPassword }` alongside the
 * enqueue; the bridge calls `verifyAdminPassword()` here first.
 *
 * Why re-auth at all:
 *   The admin already has a session. Re-entering the password defeats
 *   a stolen-session attack — if someone grabbed the admin's laptop
 *   with TitanX open, they can issue non-destructive commands (already
 *   in Phase F) but can't credential-rotate the entire fleet without
 *   also knowing the password.
 *
 * Rate limit:
 *   3 attempts per 5 minutes per user. Absolute prevention of
 *   brute-force on a bcrypt hash (which costs ~250ms on modern
 *   hardware) is fine at this rate — 3 guesses every 5 min ≈ 864/day.
 *   A proper brute-force needs to also bypass the initial session
 *   which makes the total attack surface << 1e12 guesses for typical
 *   passwords.
 *
 * NOT a substitute for the signing key:
 *   Re-auth proves the admin is present. The Ed25519 signature proves
 *   the master minted the envelope. Both layers required for
 *   destructive commands — independent controls.
 */

import bcrypt from 'bcryptjs';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const MAX_ATTEMPTS_PER_WINDOW = 3;

/**
 * In-memory attempt tracker keyed by userId. Process-local is fine —
 * clearing on restart only helps an attacker who can restart the app
 * (and they already have admin access if they can).
 */
const _attempts = new Map<string, { count: number; windowStart: number }>();

export type ReauthResult =
  | { ok: true }
  | { ok: false; reason: 'rate_limited' | 'unknown_user' | 'wrong_password' | 'error' };

export function __resetReauthForTests(): void {
  _attempts.clear();
}

/**
 * Verify the admin's password. The `userId` is what the bridge passes
 * in — typically 'system_default_user' for the desktop install. Bumps
 * the attempt counter even on success so a flood of legitimate
 * re-auths (repeated destructive ops) still gets rate-limited,
 * matching what a brute-forcer would see.
 */
export async function verifyAdminPassword(
  db: ISqliteDriver,
  userId: string,
  password: string
): Promise<ReauthResult> {
  // Rate check BEFORE the DB lookup so a flood of bogus userIds can't
  // scan the users table.
  if (!bumpAttempt(userId)) {
    return { ok: false, reason: 'rate_limited' };
  }

  // Fetch the hash. Constant-time-ish from here on — bcrypt.compare
  // is deliberately slow to defeat brute-force on the hash.
  let row: { password_hash: string } | undefined;
  try {
    row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
      | { password_hash: string }
      | undefined;
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (!row) {
    // Still pay the bcrypt cost against a dummy hash so timing doesn't
    // leak "user exists" vs "password wrong". Same pattern as
    // AuthService.DUMMY_BCRYPT_HASH.
    await bcrypt
      .compare(
        password,
        '$2a$12$s5cKddFA1hp06nhAubmZa.eT3/xT9Bmve36cul7fZ6ch2mz9EITDu'
      )
      .catch(() => false);
    return { ok: false, reason: 'unknown_user' };
  }

  const same = await bcrypt.compare(password, row.password_hash).catch(() => false);
  if (!same) return { ok: false, reason: 'wrong_password' };
  return { ok: true };
}

/**
 * Increment the attempt counter for this userId. Returns false when
 * the user is currently rate-limited (caller must short-circuit
 * without even touching bcrypt).
 */
function bumpAttempt(userId: string): boolean {
  const now = Date.now();
  const entry = _attempts.get(userId);
  if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) {
    _attempts.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS_PER_WINDOW) {
    return false;
  }
  entry.count += 1;
  return true;
}
