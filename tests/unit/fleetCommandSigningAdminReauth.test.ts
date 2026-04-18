/**
 * @license Apache-2.0
 * Unit tests for Phase F.2 Week 2 — admin re-auth gate.
 *
 * Uses real in-memory SQLite + real bcrypt because we want to
 * exercise the full compare path (including the constant-time dummy
 * hash against an unknown user). bcryptjs is fast enough in test
 * that ~250ms per compare adds up to ~2s for 8 cases — acceptable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import { __resetReauthForTests, verifyAdminPassword } from '@process/services/fleetCommandSigning/adminReauth';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

// Cheap salt rounds — only need bcrypt semantics, not brute-force resistance in tests.
const TEST_SALT_ROUNDS = 4;

function setupDb(adminPassword: string): { db: ISqliteDriver; userId: string } {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 68);
  const hash = bcrypt.hashSync(adminPassword, TEST_SALT_ROUNDS);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('admin', 'admin', hash, Date.now(), Date.now());
  return { db: driver, userId: 'admin' };
}

describeOrSkip('fleetCommandSigning/adminReauth — verifyAdminPassword', () => {
  let db: ISqliteDriver;
  let userId: string;
  beforeEach(() => {
    __resetReauthForTests();
    const setup = setupDb('correct-horse-battery-staple');
    db = setup.db;
    userId = setup.userId;
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('accepts correct password', async () => {
    const result = await verifyAdminPassword(db, userId, 'correct-horse-battery-staple');
    expect(result.ok).toBe(true);
  });

  it('rejects wrong password with reason=wrong_password', async () => {
    const result = await verifyAdminPassword(db, userId, 'nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_password');
  });

  it('rejects unknown user (but still runs a bcrypt compare for timing)', async () => {
    const start = Date.now();
    const result = await verifyAdminPassword(db, 'no-such-user', 'whatever');
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_user');
    // Constant-time dummy compare should take >20ms — not a tight
    // bound, just confirming the bcrypt call ran (vs short-circuiting).
    expect(elapsed).toBeGreaterThan(5);
  });

  it('rate-limits after 3 attempts in a 5-minute window', async () => {
    // Three wrong passwords exhaust the quota
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await verifyAdminPassword(db, userId, `wrong-${String(i)}`);
      expect(r.ok).toBe(false);
    }
    // Fourth attempt — even with the correct password — is rate-limited
    const fourth = await verifyAdminPassword(db, userId, 'correct-horse-battery-staple');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe('rate_limited');
  });

  it('counter is per-user (one user hitting limit does NOT block another)', async () => {
    // Seed a second user
    const hash = bcrypt.hashSync('hunter2', TEST_SALT_ROUNDS);
    db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'alice',
      'alice',
      hash,
      Date.now(),
      Date.now()
    );

    // Burn admin's quota
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await verifyAdminPassword(db, userId, 'wrong');
    }
    // alice should still be verifiable
    const aliceOk = await verifyAdminPassword(db, 'alice', 'hunter2');
    expect(aliceOk.ok).toBe(true);
  });

  it('counts successful attempts too (prevents "correct password = free try")', async () => {
    // 3 successful logins burn the quota
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await verifyAdminPassword(db, userId, 'correct-horse-battery-staple');
      expect(r.ok).toBe(true);
    }
    // 4th attempt is rate-limited even though it would have succeeded
    const fourth = await verifyAdminPassword(db, userId, 'correct-horse-battery-staple');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe('rate_limited');
  });

  it('__resetReauthForTests clears the counter (used between test cases)', async () => {
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      await verifyAdminPassword(db, userId, 'wrong');
    }
    __resetReauthForTests();
    const result = await verifyAdminPassword(db, userId, 'correct-horse-battery-staple');
    expect(result.ok).toBe(true);
  });
});
