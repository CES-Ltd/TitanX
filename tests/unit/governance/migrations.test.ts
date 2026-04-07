/**
 * @license Apache-2.0
 * Tests for TitanX database migrations v23-v25.
 * Verifies tables are created correctly and data can be inserted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { initSchema, getDatabaseVersion, CURRENT_DB_VERSION } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';

let nativeModuleAvailable = true;
try {
  const d = new BetterSqlite3Driver(':memory:');
  d.close();
} catch {
  nativeModuleAvailable = false;
}

const describeOrSkip = nativeModuleAvailable ? describe : describe.skip;

describeOrSkip('governance migrations v23-v25', () => {
  let driver: BetterSqlite3Driver;

  afterEach(() => {
    driver?.close();
  });

  it('should set CURRENT_DB_VERSION to 25', () => {
    expect(CURRENT_DB_VERSION).toBe(25);
  });

  it('should apply migrations v23-v25 without errors', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    // Run all migrations up to v25
    expect(() => runMigrations(driver, 0, 25)).not.toThrow();
  });

  it('should create activity_log table in v23', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, 23);

    const tables = driver
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_log'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    // Verify columns
    const columns = driver.prepare('PRAGMA table_info(activity_log)').all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('actor_type');
    expect(colNames).toContain('action');
    expect(colNames).toContain('entity_type');
    expect(colNames).toContain('details');
  });

  it('should create secrets and secret_versions tables in v23', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, 23);

    const tables = driver
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('secrets', 'secret_versions') ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['secret_versions', 'secrets']);
  });

  it('should create cost_events and budget tables in v24', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, 24);

    const tables = driver
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cost_events', 'budget_policies', 'budget_incidents') ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['budget_incidents', 'budget_policies', 'cost_events']);
  });

  it('should create agent_runs and approvals tables in v25', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, 25);

    const tables = driver
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_runs', 'approvals') ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['agent_runs', 'approvals']);
  });

  it('should allow inserting into all new tables', () => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, 25);

    // Insert test user
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u1', 'test', 'hash', Date.now(), Date.now());

    // activity_log
    expect(() =>
      driver
        .prepare(
          "INSERT INTO activity_log (id, user_id, actor_type, actor_id, action, entity_type, created_at) VALUES ('a1', 'u1', 'user', 'u1', 'test', 'test', ?)"
        )
        .run(Date.now())
    ).not.toThrow();

    // secrets + secret_versions
    const now = Date.now();
    expect(() =>
      driver
        .prepare(
          "INSERT INTO secrets (id, user_id, name, provider, current_version, created_at, updated_at) VALUES ('s1', 'u1', 'KEY', 'local_encrypted', 1, ?, ?)"
        )
        .run(now, now)
    ).not.toThrow();
    expect(() =>
      driver
        .prepare(
          "INSERT INTO secret_versions (id, secret_id, version, material, value_sha256, created_at) VALUES ('sv1', 's1', 1, '{}', 'abc', ?)"
        )
        .run(now)
    ).not.toThrow();

    // cost_events
    expect(() =>
      driver
        .prepare(
          "INSERT INTO cost_events (id, user_id, provider, model, occurred_at) VALUES ('c1', 'u1', 'openai', 'gpt-4o', ?)"
        )
        .run(now)
    ).not.toThrow();

    // budget_policies + budget_incidents
    expect(() =>
      driver
        .prepare(
          "INSERT INTO budget_policies (id, user_id, scope_type, amount_cents, created_at, updated_at) VALUES ('bp1', 'u1', 'global', 5000, ?, ?)"
        )
        .run(now, now)
    ).not.toThrow();
    expect(() =>
      driver
        .prepare(
          "INSERT INTO budget_incidents (id, policy_id, user_id, status, spend_cents, limit_cents, created_at) VALUES ('bi1', 'bp1', 'u1', 'active', 6000, 5000, ?)"
        )
        .run(now)
    ).not.toThrow();

    // Insert conversation for agent_runs FK
    driver
      .prepare(
        "INSERT INTO conversations (id, user_id, name, type, extra, created_at, updated_at) VALUES ('cv1', 'u1', 'Test', 'gemini', '{}', ?, ?)"
      )
      .run(now, now);

    // agent_runs
    expect(() =>
      driver
        .prepare(
          "INSERT INTO agent_runs (id, user_id, conversation_id, agent_type, started_at) VALUES ('r1', 'u1', 'cv1', 'gemini', ?)"
        )
        .run(now)
    ).not.toThrow();

    // approvals
    expect(() =>
      driver
        .prepare(
          "INSERT INTO approvals (id, user_id, type, requested_by, created_at) VALUES ('ap1', 'u1', 'budget_override', 'agent-1', ?)"
        )
        .run(now)
    ).not.toThrow();
  });
});
