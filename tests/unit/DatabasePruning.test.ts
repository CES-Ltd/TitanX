/**
 * @license Apache-2.0
 * Unit tests for the database pruning service.
 *
 * Uses a hand-rolled in-memory ISqliteDriver stub (no native better-sqlite3 —
 * that module is built for Electron ABI and won't load under Vitest's plain Node).
 * The stub captures every prepared statement + args so we can assert the exact
 * SQL the pruning service would run, and simulate filtered result sets.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ISqliteDriver, IStatement } from '@process/services/database/drivers/ISqliteDriver';
import { pruneStaleData } from '@process/services/database/pruning';

type ExecutedCall = { sql: string; args: readonly unknown[]; method: 'run' | 'get' | 'all' };

/** Minimal ISqliteDriver stub. */
function makeStubDriver(opts: {
  runMap?: Map<string, (args: readonly unknown[]) => number>;
  allMap?: Map<string, (args: readonly unknown[]) => unknown[]>;
}): { driver: ISqliteDriver; calls: ExecutedCall[] } {
  const calls: ExecutedCall[] = [];
  const runMap = opts.runMap ?? new Map();
  const allMap = opts.allMap ?? new Map();

  const driver: ISqliteDriver = {
    prepare(sql: string): IStatement {
      return {
        run: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'run' });
          const handler = runMap.get(sql);
          const changes = handler ? handler(args) : 0;
          return { changes, lastInsertRowid: 0 };
        },
        all: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'all' });
          const handler = allMap.get(sql);
          return handler ? handler(args) : [];
        },
        get: (...args: unknown[]) => {
          calls.push({ sql, args, method: 'get' });
          const handler = allMap.get(sql);
          const rows = handler ? handler(args) : [];
          return rows[0];
        },
      };
    },
    exec: vi.fn(),
    pragma: vi.fn(),
    transaction: (fn: (...a: unknown[]) => unknown) => fn as (...a: unknown[]) => unknown,
    close: vi.fn(),
  };

  return { driver, calls };
}

describe('DatabasePruning', () => {
  const DAY = 24 * 60 * 60 * 1000;
  /** Helper: cutoff is near the expected delta from "now at call time". */
  function expectCutoffNearMinusDays(cutoff: number, days: number): void {
    const expected = Date.now() - days * DAY;
    // pruneStaleData ran shortly before this assertion. The cutoff was
    // computed INSIDE pruneStaleData, so it's slightly older than `expected`
    // (computed here). Allow a 2-second window in either direction.
    const drift = Math.abs(cutoff - expected);
    expect(drift).toBeLessThan(2000);
  }

  describe('SQL generation', () => {
    it('issues a DELETE on activity_log with a 30-day cutoff', () => {
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);
      const activityDeletes = calls.filter((c) => c.sql.includes('DELETE FROM activity_log') && c.method === 'run');
      expect(activityDeletes).toHaveLength(1);
      expectCutoffNearMinusDays(activityDeletes[0].args[0] as number, 30);
    });

    it('issues a DELETE on sprint_tasks filtered by done/cancelled status + 7-day cutoff', () => {
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);
      const sprintDeletes = calls.filter((c) => c.sql.includes('DELETE FROM sprint_tasks') && c.method === 'run');
      expect(sprintDeletes).toHaveLength(1);
      expect(sprintDeletes[0].sql).toMatch(/status IN \('done', 'cancelled'\)/);
      expectCutoffNearMinusDays(sprintDeletes[0].args[0] as number, 7);
    });

    it('issues a DELETE on reasoning_bank scoped to usage_count=0 + 14-day cutoff', () => {
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);
      const rbDeletes = calls.filter((c) => c.sql.includes('DELETE FROM reasoning_bank') && c.method === 'run');
      expect(rbDeletes).toHaveLength(1);
      expect(rbDeletes[0].sql).toMatch(/usage_count\s*=\s*0/);
      expectCutoffNearMinusDays(rbDeletes[0].args[0] as number, 14);
    });

    it('issues a DELETE on caveman_savings with a 30-day cutoff on occurred_at', () => {
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);
      const caveDeletes = calls.filter((c) => c.sql.includes('DELETE FROM caveman_savings') && c.method === 'run');
      expect(caveDeletes).toHaveLength(1);
      expect(caveDeletes[0].sql).toMatch(/occurred_at\s*<\s*\?/);
    });

    it('deletes stale conversation messages in a single correlated DELETE (v2.1.0 N+1 fix)', () => {
      // v2.1.0 [PERF]: was N+1 — one SELECT + N DELETEs. Now one DELETE
      // with a correlated subquery scopes by conversations.updated_at.
      // This test locks down the new single-query shape.
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);

      const messageDeletes = calls.filter((c) => c.sql.includes('DELETE FROM messages') && c.method === 'run');
      expect(messageDeletes).toHaveLength(1);
      // The new shape uses `WHERE conversation_id IN (SELECT id FROM conversations ...)`
      expect(messageDeletes[0].sql).toMatch(/WHERE conversation_id IN \(/);
      expect(messageDeletes[0].sql).toMatch(/FROM conversations/);
      expect(messageDeletes[0].sql).toMatch(/status != 'running'/);
      // One arg: the messages-cutoff timestamp, ~14 days ago.
      expect(messageDeletes[0].args).toHaveLength(1);
      expectCutoffNearMinusDays(messageDeletes[0].args[0] as number, 14);
    });

    it('still runs exactly one messages DELETE even when no conversations are stale', () => {
      // With the new correlated DELETE we always issue one statement;
      // SQLite's WHERE IN on an empty subquery just deletes 0 rows,
      // which is cheaper than the old "skip the delete" branch.
      const { driver, calls } = makeStubDriver({});
      pruneStaleData(driver);
      const messageDeletes = calls.filter((c) => c.sql.includes('DELETE FROM messages') && c.method === 'run');
      expect(messageDeletes).toHaveLength(1);
    });
  });

  describe('VACUUM trigger', () => {
    it('runs incremental_vacuum when > 10000 rows were deleted (v2.1.0 raised threshold)', () => {
      // Threshold was 100 before v2.1.0 — too aggressive on busy installs.
      // 10k keeps VACUUM for genuinely large sweeps; smaller deletes
      // avoid the write-lock pause that came with the old cadence.
      const runMap = new Map<string, (args: readonly unknown[]) => number>();
      runMap.set('DELETE FROM activity_log WHERE created_at < ?', () => 10_001);
      const { driver } = makeStubDriver({ runMap });
      pruneStaleData(driver);
      expect(driver.exec).toHaveBeenCalledWith('PRAGMA incremental_vacuum(1000)');
    });

    it('does NOT run VACUUM when fewer than 10000 rows were deleted', () => {
      const runMap = new Map<string, (args: readonly unknown[]) => number>();
      runMap.set('DELETE FROM activity_log WHERE created_at < ?', () => 5);
      const { driver } = makeStubDriver({ runMap });
      pruneStaleData(driver);
      expect(driver.exec).not.toHaveBeenCalledWith('PRAGMA incremental_vacuum(1000)');
      expect(driver.exec).not.toHaveBeenCalledWith('PRAGMA incremental_vacuum(100)');
    });
  });

  describe('resilience', () => {
    it('swallows errors from individual tables — one failure does not abort the whole sweep', () => {
      // Make activity_log throw; other tables should still be pruned.
      const failDriver: ISqliteDriver = {
        prepare(sql: string): IStatement {
          if (sql.startsWith('DELETE FROM activity_log')) {
            return {
              run: () => {
                throw new Error('trigger blocked delete');
              },
              all: () => [],
              get: () => undefined,
            };
          }
          return {
            run: () => ({ changes: 0, lastInsertRowid: 0 }),
            all: () => [],
            get: () => undefined,
          };
        },
        exec: vi.fn(),
        pragma: vi.fn(),
        transaction: (fn: (...a: unknown[]) => unknown) => fn as (...a: unknown[]) => unknown,
        close: vi.fn(),
      };
      expect(() => pruneStaleData(failDriver)).not.toThrow();
    });
  });
});
