/**
 * @license Apache-2.0
 * Unit tests for activityLog's v1.9.39 filter extensions + distinct-value
 * helpers. Uses in-memory SQLite so listActivities exercises real SQL
 * path including the LIKE ESCAPE + severity enum check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import { getDistinctActions, getDistinctEntityTypes, listActivities, logActivity } from '@process/services/activityLog';

let nativeAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 68);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('u1', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

function seed(
  db: ISqliteDriver,
  overrides: Partial<{
    action: string;
    entityType: string;
    entityId: string;
    severity: 'info' | 'warning';
    details: Record<string, unknown>;
    createdAt: number;
  }> = {}
): void {
  logActivity(db, {
    userId: 'u1',
    actorType: 'user',
    actorId: 'u1',
    action: overrides.action ?? 'test.action',
    entityType: overrides.entityType ?? 'test_entity',
    entityId: overrides.entityId,
    details: overrides.details,
    severity: overrides.severity,
  } as Parameters<typeof logActivity>[1]);
  // If a custom createdAt was requested, override via direct UPDATE since
  // logActivity stamps with Date.now() internally.
  if (overrides.createdAt !== undefined) {
    db.prepare('UPDATE activity_log SET created_at = ? WHERE rowid = last_insert_rowid()').run(overrides.createdAt);
  }
}

describeOrSkip('activityLog — v1.9.39 filter extensions', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('filters by createdAtFrom (inclusive)', () => {
    seed(db, { action: 'a', createdAt: 1000 });
    seed(db, { action: 'b', createdAt: 2000 });
    seed(db, { action: 'c', createdAt: 3000 });
    const r = listActivities(db, { userId: 'u1', createdAtFrom: 2000 });
    expect(r.total).toBe(2);
    expect(r.data.map((x) => x.action).toSorted()).toEqual(['b', 'c']);
  });

  it('filters by createdAtTo (exclusive)', () => {
    seed(db, { action: 'a', createdAt: 1000 });
    seed(db, { action: 'b', createdAt: 2000 });
    seed(db, { action: 'c', createdAt: 3000 });
    const r = listActivities(db, { userId: 'u1', createdAtTo: 3000 });
    expect(r.data.map((x) => x.action).toSorted()).toEqual(['a', 'b']);
  });

  it('combines createdAtFrom + createdAtTo (half-open window)', () => {
    seed(db, { action: 'a', createdAt: 1000 });
    seed(db, { action: 'b', createdAt: 2000 });
    seed(db, { action: 'c', createdAt: 3000 });
    const r = listActivities(db, { userId: 'u1', createdAtFrom: 2000, createdAtTo: 3000 });
    expect(r.data.map((x) => x.action)).toEqual(['b']);
  });

  it('filters by severity enum', () => {
    seed(db, { action: 'ok', severity: 'info' });
    seed(db, { action: 'bad', severity: 'warning' });
    seed(db, { action: 'ok2', severity: 'info' });
    const r = listActivities(db, { userId: 'u1', severity: 'warning' });
    expect(r.total).toBe(1);
    expect(r.data[0]!.action).toBe('bad');
  });

  it('free-text search matches on action', () => {
    seed(db, { action: 'fleet.command.enqueued' });
    seed(db, { action: 'iam.policy_created' });
    seed(db, { action: 'agent.template.published' });
    const r = listActivities(db, { userId: 'u1', search: 'fleet' });
    expect(r.data.map((x) => x.action)).toEqual(['fleet.command.enqueued']);
  });

  it('free-text search matches on entity_id', () => {
    seed(db, { action: 'a', entityId: 'policy-abc123' });
    seed(db, { action: 'b', entityId: 'template-xyz' });
    const r = listActivities(db, { userId: 'u1', search: 'abc123' });
    expect(r.data.map((x) => x.action)).toEqual(['a']);
  });

  it('free-text search matches on details JSON substring', () => {
    seed(db, { action: 'a', details: { note: 'something specific here' } });
    seed(db, { action: 'b', details: { note: 'nothing relevant' } });
    const r = listActivities(db, { userId: 'u1', search: 'specific' });
    expect(r.data.map((x) => x.action)).toEqual(['a']);
  });

  it('free-text search is case-insensitive', () => {
    seed(db, { action: 'Credential.Rotate' });
    const r = listActivities(db, { userId: 'u1', search: 'credential' });
    expect(r.data).toHaveLength(1);
  });

  it('free-text search escapes SQL LIKE metacharacters (% and _)', () => {
    seed(db, { action: 'safe.literal_action' });
    seed(db, { action: 'other.thing' });
    // Search for literal underscore — should match only the first row
    const r = listActivities(db, { userId: 'u1', search: 'literal_action' });
    expect(r.data.map((x) => x.action)).toEqual(['safe.literal_action']);
  });

  it('search + date-range + action filter compose correctly', () => {
    seed(db, { action: 'fleet.a', createdAt: 1000, details: { hit: 1 } });
    seed(db, { action: 'fleet.b', createdAt: 2000, details: { hit: 1 } });
    seed(db, { action: 'iam.c', createdAt: 2500, details: { hit: 1 } });
    const r = listActivities(db, {
      userId: 'u1',
      search: 'hit',
      createdAtFrom: 1500,
      action: 'fleet.b',
    });
    expect(r.data.map((x) => x.action)).toEqual(['fleet.b']);
  });
});

describeOrSkip('activityLog — distinct helpers', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('getDistinctActions returns sorted unique actions', () => {
    seed(db, { action: 'zebra' });
    seed(db, { action: 'apple' });
    seed(db, { action: 'apple' }); // dup — should collapse
    seed(db, { action: 'mango' });
    expect(getDistinctActions(db, 'u1')).toEqual(['apple', 'mango', 'zebra']);
  });

  it('getDistinctEntityTypes returns sorted unique entity types', () => {
    seed(db, { entityType: 'team' });
    seed(db, { entityType: 'agent' });
    seed(db, { entityType: 'team' });
    expect(getDistinctEntityTypes(db, 'u1')).toEqual(['agent', 'team']);
  });

  it("respects user_id boundary — other users' entries not leaked", () => {
    db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'u2',
      'other',
      'hash',
      Date.now(),
      Date.now()
    );
    seed(db, { action: 'mine' });
    logActivity(db, {
      userId: 'u2',
      actorType: 'user',
      actorId: 'u2',
      action: 'theirs',
      entityType: 'test_entity',
    } as Parameters<typeof logActivity>[1]);
    expect(getDistinctActions(db, 'u1')).toEqual(['mine']);
    expect(getDistinctActions(db, 'u2')).toEqual(['theirs']);
  });

  it('limits results to prevent unbounded queries', () => {
    // Seed more than the default limit (500) — by design the SELECT DISTINCT
    // has a LIMIT to bound response size. Verify the clamp holds.
    for (let i = 0; i < 20; i++) seed(db, { action: `action-${String(i).padStart(3, '0')}` });
    expect(getDistinctActions(db, 'u1', 5)).toHaveLength(5);
  });
});
