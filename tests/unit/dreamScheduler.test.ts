/**
 * @license Apache-2.0
 * Unit tests for the Phase C v1.11.0 Dream Mode scheduler.
 *
 * Covers the pure-logic bits:
 *   - msUntilNextHour — time-of-day math used by the nightly 03:00 run
 *   - runDreamPass core behavior — dedup by trajectory_hash, max-score
 *     winning cluster, top-N ranking, consolidated_version marker
 *
 * Uses mocks for DB + LLM so the tests are deterministic and fast.
 * No real SQLite here — the migration-v70 shape is exercised by a
 * separate native-sqlite suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks for the dream scheduler's collaborators ──────────────────────

vi.mock('@process/services/database', () => ({
  getDatabase: async () => ({ getDriver: () => driver }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { fleet: { destructiveExecuted: { emit: () => undefined } } },
}));

// Minimal in-memory DB stub that tracks fleet_learnings + consolidated_learnings.
type LearningRow = {
  id: string;
  device_id: string;
  payload: string;
  success_score: number | null;
  usage_count_local: number | null;
  consolidated_version: number | null;
};
type ConsolidatedRow = {
  version: number;
  published_at: number;
  payload: string;
  trajectory_count: number;
  contributing_devices: number;
};

let learningRows: LearningRow[] = [];
let consolidatedRows: ConsolidatedRow[] = [];

function makeDriver(): unknown {
  return {
    prepare(sql: string) {
      if (sql.includes('FROM fleet_learnings') && sql.includes("learning_type = 'trajectory'")) {
        return {
          all: () => learningRows.filter((r) => r.consolidated_version == null).map((r) => ({ ...r })),
        };
      }
      if (sql.includes('COALESCE(MAX(version), 0)') && sql.includes('consolidated_learnings')) {
        return {
          get: () => ({ v: consolidatedRows.length > 0 ? Math.max(...consolidatedRows.map((r) => r.version)) : 0 }),
        };
      }
      if (sql.startsWith('INSERT INTO consolidated_learnings')) {
        return {
          run: (
            version: number,
            publishedAt: number,
            payload: string,
            trajectoryCount: number,
            contributingDevices: number
          ) => {
            consolidatedRows.push({
              version,
              published_at: publishedAt,
              payload,
              trajectory_count: trajectoryCount,
              contributing_devices: contributingDevices,
            });
          },
        };
      }
      if (sql.startsWith('UPDATE fleet_learnings SET consolidated_version')) {
        return {
          run: (version: number, ...ids: string[]) => {
            for (const id of ids) {
              const row = learningRows.find((r) => r.id === id);
              if (row) row.consolidated_version = version;
            }
          },
        };
      }
      // activity_log catch-all — swallow writes.
      return { run: () => undefined, get: () => undefined, all: () => [] };
    },
  };
}

let driver: unknown;

import {
  msUntilNextHour,
  runDreamPass,
  __resetDreamSchedulerForTests,
} from '@process/services/fleetLearning/dreamScheduler';

function seedTrajectory(id: string, deviceId: string, hash: string, task: string, score: number, usage: number): void {
  learningRows.push({
    id,
    device_id: deviceId,
    payload: JSON.stringify({
      trajectoryHash: hash,
      taskDescription: task,
      trajectoryJson: '[]',
    }),
    success_score: score,
    usage_count_local: usage,
    consolidated_version: null,
  });
}

describe('msUntilNextHour', () => {
  it('returns positive ms when target hour is later today', () => {
    const now = new Date('2026-04-18T14:00:00');
    const ms = msUntilNextHour(now, 18);
    // 4 hours * 3600 * 1000 = 14_400_000
    expect(ms).toBe(4 * 60 * 60 * 1000);
  });

  it('rolls over to tomorrow when target hour already passed', () => {
    const now = new Date('2026-04-18T14:00:00');
    const ms = msUntilNextHour(now, 3);
    // 13 hours to next 03:00
    expect(ms).toBe(13 * 60 * 60 * 1000);
  });

  it('rolls over to tomorrow when current time == target hour exactly', () => {
    const now = new Date('2026-04-18T03:00:00');
    const ms = msUntilNextHour(now, 3);
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });
});

describe('runDreamPass', () => {
  beforeEach(() => {
    learningRows = [];
    consolidatedRows = [];
    driver = makeDriver();
    __resetDreamSchedulerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedups trajectories with same hash across devices and sums usage', async () => {
    seedTrajectory('j1', 'dev-a', 'hash-A', 'do X', 0.8, 3);
    seedTrajectory('j2', 'dev-b', 'hash-A', 'do X', 0.9, 5);
    seedTrajectory('j3', 'dev-c', 'hash-A', 'do X', 0.7, 2);

    const result = await runDreamPass(driver as never);

    expect(result.trajectoryCount).toBe(1);
    expect(result.contributingDevices).toBe(3);
    expect(consolidatedRows).toHaveLength(1);
    const entries = JSON.parse(consolidatedRows[0]!.payload) as Array<{
      trajectoryHash: string;
      successScore: number;
      usageCountFleetwide: number;
      contributingDevices: number;
    }>;
    expect(entries[0]!.trajectoryHash).toBe('hash-A');
    // Winning trajectory is the one with max success_score (0.9)
    expect(entries[0]!.successScore).toBe(0.9);
    // Total usage = 3 + 5 + 2 = 10
    expect(entries[0]!.usageCountFleetwide).toBe(10);
    expect(entries[0]!.contributingDevices).toBe(3);
  });

  it('keeps distinct clusters separate', async () => {
    seedTrajectory('j1', 'dev-a', 'hash-A', 'task-A', 0.8, 3);
    seedTrajectory('j2', 'dev-a', 'hash-B', 'task-B', 0.9, 2);
    seedTrajectory('j3', 'dev-b', 'hash-A', 'task-A', 0.5, 1);

    const result = await runDreamPass(driver as never);

    expect(result.trajectoryCount).toBe(2);
    // dev-a + dev-b contributed to hash-A; dev-a alone for hash-B
    expect(result.contributingDevices).toBe(2);
  });

  it('ranks clusters by (usage * successScore) descending and truncates to keepTopN', async () => {
    // High-usage low-score cluster.
    seedTrajectory('j1', 'dev-a', 'hash-low', 'boring', 0.3, 100);
    // Mid-usage mid-score.
    seedTrajectory('j2', 'dev-a', 'hash-mid', 'okay', 0.5, 20);
    // Low-usage high-score.
    seedTrajectory('j3', 'dev-a', 'hash-high', 'great', 0.99, 5);

    // keepTopN=2 → the "boring" (0.3 * 100 = 30) and "okay" (0.5 * 20 = 10) win,
    // because "great" is 0.99 * 5 = 4.95.
    const result = await runDreamPass(driver as never, { keepTopN: 2 });
    expect(result.trajectoryCount).toBe(2);
    const entries = JSON.parse(consolidatedRows[0]!.payload) as Array<{ trajectoryHash: string }>;
    expect(entries.map((e) => e.trajectoryHash)).toEqual(['hash-low', 'hash-mid']);
  });

  it('marks source rows consolidated so next run skips them', async () => {
    seedTrajectory('j1', 'dev-a', 'hash-A', 'task-A', 0.8, 3);
    const first = await runDreamPass(driver as never);
    expect(first.trajectoryCount).toBe(1);
    expect(learningRows[0]!.consolidated_version).toBe(first.version);

    // Second pass with no new rows — creates version+1 but empty payload.
    const second = await runDreamPass(driver as never);
    expect(second.version).toBe(first.version + 1);
    expect(second.trajectoryCount).toBe(0);
  });

  it('increments version monotonically across runs', async () => {
    seedTrajectory('j1', 'dev-a', 'hash-A', 'task-A', 0.8, 3);
    const r1 = await runDreamPass(driver as never);
    // Seed a new row after first pass completes.
    seedTrajectory('j2', 'dev-a', 'hash-B', 'task-B', 0.9, 2);
    const r2 = await runDreamPass(driver as never);
    expect(r2.version).toBe(r1.version + 1);
    expect(r2.trajectoryCount).toBe(1); // only the new unconsolidated row
  });
});
