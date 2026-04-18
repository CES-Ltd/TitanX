/**
 * @license Apache-2.0
 * Unit tests for the Phase C v1.11.0 fleetLearning core service
 * (envelope builder + master ingestion + consolidated accessor).
 *
 * Exercises migration v70 via real SQLite so the CHECK constraints
 * and unique indexes run. Skipped where better-sqlite3's native
 * binding can't load — same guard pattern as the other migration
 * tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import {
  buildLearningEnvelope,
  getLatestConsolidated,
  ingestLearningEnvelope,
  listPatternContributors,
  markEnvelopePushed,
} from '@process/services/fleetLearning';

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
  runMigrations(driver, 0, 70);
  driver
    .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('system_default_user', 'admin', 'hash', Date.now(), Date.now());
  return driver;
}

function seedTrajectory(
  db: ISqliteDriver,
  id: string,
  hash: string,
  task: string,
  score: number,
  usage: number,
  sourceTag: string | null = null,
  updatedAt: number = Date.now()
): void {
  db.prepare(
    `INSERT INTO reasoning_bank
     (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at, source_tag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    hash,
    task,
    JSON.stringify([{ toolName: 'echo', args: {}, result: 'ok', durationMs: 10 }]),
    score,
    usage,
    updatedAt,
    updatedAt,
    sourceTag
  );
}

function seedMemorySummary(
  db: ISqliteDriver,
  id: string,
  agentSlot: string,
  content: string,
  tokens: number,
  updatedAt: number = Date.now()
): void {
  db.prepare(
    `INSERT INTO agent_memory
     (id, agent_slot_id, team_id, memory_type, content, token_count, relevance_score, created_at, updated_at)
     VALUES (?, ?, ?, 'summary', ?, ?, 0.5, ?, ?)`
  ).run(id, agentSlot, 'team-1', content, tokens, updatedAt, updatedAt);
}

// ── Migration v70 shape ─────────────────────────────────────────────────

describeOrSkip('Migration v70 — Dream Mode tables', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('creates learning_exports with correct CHECK + unique constraint', () => {
    const info = db.prepare('PRAGMA table_info(learning_exports)').all() as Array<{ name: string }>;
    const cols = info.map((c) => c.name).toSorted();
    expect(cols).toContain('source_table');
    expect(cols).toContain('pushed_at');

    // CHECK rejects unknown source_table.
    expect(() =>
      db
        .prepare(
          `INSERT INTO learning_exports (id, source_table, source_id, window_start, window_end) VALUES (?, ?, ?, ?, ?)`
        )
        .run('x1', 'bogus', 's1', 0, 1)
    ).toThrow();

    // Unique constraint on (source_table, source_id, window_end).
    db.prepare(
      `INSERT INTO learning_exports (id, source_table, source_id, window_start, window_end) VALUES (?, ?, ?, ?, ?)`
    ).run('x1', 'reasoning_bank', 's1', 0, 1000);
    expect(() =>
      db
        .prepare(
          `INSERT INTO learning_exports (id, source_table, source_id, window_start, window_end) VALUES (?, ?, ?, ?, ?)`
        )
        .run('x2', 'reasoning_bank', 's1', 0, 1000)
    ).toThrow();
  });

  it('creates fleet_learnings with type CHECK + partial unconsolidated index', () => {
    const indexes = db.prepare('PRAGMA index_list(fleet_learnings)').all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_fleet_learnings_unconsolidated');
    expect(indexes.map((i) => i.name)).toContain('idx_fleet_learnings_device');

    expect(() =>
      db
        .prepare(
          `INSERT INTO fleet_learnings (id, device_id, learning_type, payload, received_at) VALUES (?, ?, ?, ?, ?)`
        )
        .run('fl1', 'dev-a', 'banana', '{}', Date.now())
    ).toThrow();
  });

  it('adds reasoning_bank.source_tag column with partial index', () => {
    const info = db.prepare('PRAGMA table_info(reasoning_bank)').all() as Array<{ name: string }>;
    expect(info.some((c) => c.name === 'source_tag')).toBe(true);
    const indexes = db.prepare('PRAGMA index_list(reasoning_bank)').all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_reasoning_bank_source_tag');
  });
});

// ── Envelope builder ───────────────────────────────────────────────────

describeOrSkip('buildLearningEnvelope', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns null when no exportable rows exist', () => {
    const env = buildLearningEnvelope(db, 0, Date.now());
    expect(env).toBeNull();
  });

  it('picks locally-minted trajectories only (skips source_tag=fleet_consolidated)', () => {
    seedTrajectory(db, 't1', 'hash-A', 'local task', 0.9, 5, null);
    seedTrajectory(db, 't2', 'hash-B', 'fleet broadcast', 0.8, 3, 'fleet_consolidated');

    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env).not.toBeNull();
    expect(env!.trajectories).toHaveLength(1);
    expect(env!.trajectories[0]!.trajectoryHash).toBe('hash-A');
  });

  it('excludes already-exported rows for the same window', () => {
    seedTrajectory(db, 't1', 'hash-A', 'task', 0.9, 5, null);
    // Mark it exported
    db.prepare(
      `INSERT INTO learning_exports (id, source_table, source_id, window_start, window_end, pushed_at)
       VALUES (?, 'reasoning_bank', 't1', 0, 5000, ?)`
    ).run('exp1', Date.now());

    const env = buildLearningEnvelope(db, 0, 10000);
    expect(env).toBeNull();
  });

  it('enforces the MAX_TRAJECTORIES_PER_WINDOW cap', () => {
    // Seed 105 rows; limit is 100.
    for (let i = 0; i < 105; i++) {
      seedTrajectory(db, `t${String(i)}`, `hash-${String(i)}`, `task-${String(i)}`, 0.5, i + 1);
    }
    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env!.trajectories.length).toBe(100);
  });

  it('redacts secrets in task descriptions', () => {
    seedTrajectory(db, 't1', 'hash-A', 'call openai with sk-abcdef123456789012345', 0.9, 5, null);
    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env!.trajectories[0]!.taskDescription).not.toContain('sk-');
    expect(env!.trajectories[0]!.taskDescription).toContain('***REDACTED***');
  });

  it('anonymizes agent slot ids in memory summaries', () => {
    seedMemorySummary(db, 'm1', 'real-slot-id-abc', '{"text":"summary"}', 50);
    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env!.memorySummaries).toHaveLength(1);
    const hash = env!.memorySummaries[0]!.agentSlotHash;
    expect(hash).not.toBe('real-slot-id-abc');
    // 16-char hex prefix (SHA256 truncated)
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ── markEnvelopePushed ─────────────────────────────────────────────────

describeOrSkip('markEnvelopePushed', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('records each trajectory as exported so next build skips it', () => {
    seedTrajectory(db, 't1', 'hash-A', 'task', 0.9, 5, null);
    const env1 = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env1!.trajectories).toHaveLength(1);
    markEnvelopePushed(db, env1!);

    const env2 = buildLearningEnvelope(db, 0, Date.now() + 2000);
    expect(env2).toBeNull();
  });
});

// ── Master-side ingestion ──────────────────────────────────────────────

describeOrSkip('ingestLearningEnvelope', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('fans trajectories + summaries into fleet_learnings rows', () => {
    const result = ingestLearningEnvelope(db, 'dev-a', {
      windowStart: 0,
      windowEnd: 100,
      trajectories: [
        {
          trajectoryHash: 'hash-A',
          taskDescription: 'x',
          trajectoryJson: '[]',
          successScore: 0.7,
          usageCountLocal: 3,
        },
      ],
      memorySummaries: [{ agentSlotHash: 'abc123', contentJson: '{}', tokenCount: 10 }],
    });
    expect(result).toEqual({ trajectories: 1, memorySummaries: 1 });

    const rows = db.prepare('SELECT learning_type, device_id FROM fleet_learnings').all() as Array<{
      learning_type: string;
      device_id: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.device_id === 'dev-a')).toBe(true);
    const types = rows.map((r) => r.learning_type).toSorted();
    expect(types).toEqual(['memory_summary', 'trajectory']);
  });

  it('accepts an empty envelope without writing rows', () => {
    const result = ingestLearningEnvelope(db, 'dev-a', {
      windowStart: 0,
      windowEnd: 100,
      trajectories: [],
      memorySummaries: [],
    });
    expect(result).toEqual({ trajectories: 0, memorySummaries: 0 });
    const count = db.prepare('SELECT COUNT(*) AS c FROM fleet_learnings').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

// ── getLatestConsolidated ──────────────────────────────────────────────

// ── End-to-end redaction validator (v1.11.2) ───────────────────────────

describeOrSkip('buildLearningEnvelope — end-to-end redaction validator', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('scrubs secrets embedded in trajectory step results (not just task_description)', () => {
    // Seed a trajectory whose STEP RESULT contains a secret — this
    // simulates an agent whose tool output accidentally echoed a key.
    // If the redactor only ran on task_description, this leak would
    // reach master uncaught.
    const secretInStep = 'Found API key: sk-abcdef0123456789abcdef0123456789';
    db.prepare(
      `INSERT INTO reasoning_bank
       (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      't1',
      'hash-A',
      'safe task description',
      JSON.stringify([
        { toolName: 'http.get', args: { url: 'https://safe.example.com' }, result: secretInStep, durationMs: 42 },
      ]),
      0.9,
      5,
      Date.now(),
      Date.now()
    );

    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    expect(env).not.toBeNull();
    const trajectoryJson = env!.trajectories[0]!.trajectoryJson;

    // The key should be gone from the serialized payload.
    expect(trajectoryJson).not.toContain('sk-abcdef');
    expect(trajectoryJson).toContain('***REDACTED***');
  });

  it('scrubs email addresses in tool args (PII minimization)', () => {
    db.prepare(
      `INSERT INTO reasoning_bank
       (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      't1',
      'hash-A',
      'send reminder',
      JSON.stringify([{ toolName: 'mail.send', args: { to: 'alice@example.com' }, result: 'sent', durationMs: 50 }]),
      0.9,
      1,
      Date.now(),
      Date.now()
    );

    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    const trajectoryJson = env!.trajectories[0]!.trajectoryJson;
    expect(trajectoryJson).not.toContain('alice@example.com');
    expect(trajectoryJson).toContain('***REDACTED***');
  });

  it('preserves non-sensitive trajectory content unchanged', () => {
    db.prepare(
      `INSERT INTO reasoning_bank
       (id, trajectory_hash, task_description, trajectory, success_score, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      't1',
      'hash-A',
      'format a JSON document',
      JSON.stringify([{ toolName: 'json.format', args: { indent: 2 }, result: '{"ok": true}', durationMs: 5 }]),
      0.95,
      3,
      Date.now(),
      Date.now()
    );

    const env = buildLearningEnvelope(db, 0, Date.now() + 1000);
    const trajectoryJson = env!.trajectories[0]!.trajectoryJson;
    expect(trajectoryJson).toContain('json.format');
    expect(trajectoryJson).not.toContain('***REDACTED***');
  });
});

// ── Drill-down contributors (v1.11.2) ──────────────────────────────────

describeOrSkip('listPatternContributors', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  function seedFleetLearning(
    id: string,
    deviceId: string,
    trajectoryHash: string,
    score: number,
    usage: number,
    consolidatedVersion: number | null = null
  ): void {
    db.prepare(
      `INSERT INTO fleet_learnings
       (id, device_id, learning_type, payload, success_score, usage_count_local, received_at, consolidated_version)
       VALUES (?, ?, 'trajectory', ?, ?, ?, ?, ?)`
    ).run(
      id,
      deviceId,
      JSON.stringify({ trajectoryHash, taskDescription: 'x', trajectoryJson: '[]' }),
      score,
      usage,
      Date.now(),
      consolidatedVersion
    );
  }

  it('returns the slaves that contributed to a given consolidated pattern', () => {
    seedFleetLearning('f1', 'dev-a', 'hash-A', 0.8, 3, 1);
    seedFleetLearning('f2', 'dev-b', 'hash-A', 0.9, 5, 1);
    seedFleetLearning('f3', 'dev-c', 'hash-B', 0.7, 2, 1); // different pattern
    seedFleetLearning('f4', 'dev-a', 'hash-A', 0.8, 3, 2); // different version

    const contributors = listPatternContributors(db, 'hash-A', 1);
    expect(contributors).toHaveLength(2);
    const deviceIds = contributors.map((c) => c.deviceId).toSorted();
    expect(deviceIds).toEqual(['dev-a', 'dev-b']);
  });

  it('returns empty when no contributors match', () => {
    seedFleetLearning('f1', 'dev-a', 'hash-A', 0.8, 3, 1);
    expect(listPatternContributors(db, 'non-existent-hash', 1)).toEqual([]);
    expect(listPatternContributors(db, 'hash-A', 999)).toEqual([]);
  });

  it('carries per-device score + usage into the response', () => {
    seedFleetLearning('f1', 'dev-a', 'hash-A', 0.75, 4, 1);
    const contributors = listPatternContributors(db, 'hash-A', 1);
    expect(contributors).toHaveLength(1);
    expect(contributors[0]!.successScore).toBe(0.75);
    expect(contributors[0]!.usageCountLocal).toBe(4);
  });
});

describeOrSkip('getLatestConsolidated', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('returns null when no dream pass has run', () => {
    expect(getLatestConsolidated(db)).toBeNull();
  });

  it('returns the highest-version payload', () => {
    db.prepare(
      `INSERT INTO consolidated_learnings (version, published_at, payload, trajectory_count, contributing_devices)
       VALUES (?, ?, ?, ?, ?)`
    ).run(1, 100, JSON.stringify([{ trajectoryHash: 'h1' }]), 1, 1);
    db.prepare(
      `INSERT INTO consolidated_learnings (version, published_at, payload, trajectory_count, contributing_devices)
       VALUES (?, ?, ?, ?, ?)`
    ).run(2, 200, JSON.stringify([{ trajectoryHash: 'h2' }]), 1, 1);

    const latest = getLatestConsolidated(db);
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(2);
    expect(latest!.entries[0]).toMatchObject({ trajectoryHash: 'h2' });
  });
});
