/**
 * @license Apache-2.0
 * Migration safety harness.
 *
 * Locks in the contract for the most recently-added migrations (v54-v59):
 *  - every migration exposes `version`, `name`, `up`, `down`
 *  - versions are strictly ordered and unique
 *  - the exported ALL_MIGRATIONS tail matches CURRENT_DB_VERSION
 *  - v56 owner-normalization correctly rewrites slotIds to agentNames
 *  - v57 agent-status-fix correctly upgrades persisted 'pending' rows
 *  - v58 replaces the immutable trigger with a 7-day retention trigger
 *  - v59 adds composite indexes
 *
 * A stub ISqliteDriver captures every SQL statement run during migration.up()
 * so we can assert intent without requiring the native better-sqlite3 build.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ISqliteDriver, IStatement } from '@process/services/database/drivers/ISqliteDriver';
import { ALL_MIGRATIONS } from '@process/services/database/migrations';
import { CURRENT_DB_VERSION } from '@process/services/database/schema';

type Captured = {
  execs: string[];
  prepares: string[];
  runs: Array<{ sql: string; args: readonly unknown[] }>;
};

function makeRecordingDriver(
  opts: {
    allHandlers?: Map<string, (args: readonly unknown[]) => unknown[]>;
  } = {}
): { driver: ISqliteDriver; captured: Captured } {
  const captured: Captured = { execs: [], prepares: [], runs: [] };
  const allHandlers = opts.allHandlers ?? new Map();
  const driver: ISqliteDriver = {
    prepare(sql: string): IStatement {
      captured.prepares.push(sql);
      return {
        run: (...args: unknown[]) => {
          captured.runs.push({ sql, args });
          return { changes: 0, lastInsertRowid: 0 };
        },
        all: (...args: unknown[]) => {
          const handler = allHandlers.get(sql);
          return handler ? handler(args) : [];
        },
        get: (...args: unknown[]) => {
          const handler = allHandlers.get(sql);
          return handler ? handler(args)[0] : undefined;
        },
      };
    },
    exec: (sql: string) => {
      captured.execs.push(sql);
    },
    pragma: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
  return { driver, captured };
}

describe('Database migrations', () => {
  describe('structural invariants', () => {
    it('every migration exposes version, name, up(), down()', () => {
      for (const m of ALL_MIGRATIONS) {
        expect(typeof m.version).toBe('number');
        expect(typeof m.name).toBe('string');
        expect(typeof m.up).toBe('function');
        expect(typeof m.down).toBe('function');
      }
    });

    it('migration versions are strictly increasing with no duplicates', () => {
      const versions = ALL_MIGRATIONS.map((m) => m.version);
      for (let i = 1; i < versions.length; i++) {
        expect(versions[i]).toBeGreaterThan(versions[i - 1]);
      }
      expect(new Set(versions).size).toBe(versions.length);
    });

    it('CURRENT_DB_VERSION equals the highest migration version', () => {
      const maxVersion = Math.max(...ALL_MIGRATIONS.map((m) => m.version));
      expect(CURRENT_DB_VERSION).toBe(maxVersion);
    });
  });

  describe('migration v56 — owner normalization', () => {
    const v56 = ALL_MIGRATIONS.find((m) => m.version === 56);

    it('adds progress_notes column and idx_tasks_owner index', () => {
      expect(v56).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v56!.up(driver);
      expect(captured.execs.some((s) => s.includes('ADD COLUMN progress_notes'))).toBe(true);
      expect(captured.execs.some((s) => s.includes('idx_tasks_owner'))).toBe(true);
    });

    it('rewrites team_tasks.owner from slotId to agentName for every mapped slot', () => {
      expect(v56).toBeDefined();
      const allHandlers = new Map<string, (args: readonly unknown[]) => unknown[]>();
      allHandlers.set('SELECT id, agents FROM teams', () => [
        {
          id: 'team-a',
          agents: JSON.stringify([
            { slotId: 'slot-fe', agentName: 'Frontend_Engineer' },
            { slotId: 'slot-be', agentName: 'Backend_Engineer' },
          ]),
        },
      ]);
      const { driver, captured } = makeRecordingDriver({ allHandlers });
      v56!.up(driver);

      const updates = captured.runs.filter((r) => r.sql.startsWith('UPDATE team_tasks SET owner'));
      expect(updates).toHaveLength(2);
      expect(updates.map((u) => u.args)).toContainEqual(['Frontend_Engineer', 'slot-fe']);
      expect(updates.map((u) => u.args)).toContainEqual(['Backend_Engineer', 'slot-be']);
    });

    it('silently skips teams with malformed agents JSON (no crash)', () => {
      const allHandlers = new Map<string, (args: readonly unknown[]) => unknown[]>();
      allHandlers.set('SELECT id, agents FROM teams', () => [{ id: 'broken', agents: '{not json' }]);
      const { driver } = makeRecordingDriver({ allHandlers });
      expect(() => v56!.up(driver)).not.toThrow();
    });
  });

  describe('migration v57 — persisted agent status fix', () => {
    const v57 = ALL_MIGRATIONS.find((m) => m.version === 57);

    it('rewrites agents.status=pending to idle in the teams JSON column', () => {
      expect(v57).toBeDefined();
      const allHandlers = new Map<string, (args: readonly unknown[]) => unknown[]>();
      allHandlers.set('SELECT id, agents FROM teams', () => [
        {
          id: 'team-a',
          agents: JSON.stringify([
            { slotId: 'a', agentName: 'A', status: 'pending' },
            { slotId: 'b', agentName: 'B', status: 'idle' },
          ]),
        },
      ]);
      const { driver, captured } = makeRecordingDriver({ allHandlers });
      v57!.up(driver);

      const updates = captured.runs.filter((r) => r.sql.startsWith('UPDATE teams SET agents'));
      expect(updates).toHaveLength(1);
      const rewritten = JSON.parse(updates[0].args[0] as string) as Array<{ status: string }>;
      expect(rewritten.map((a) => a.status)).toEqual(['idle', 'idle']);
    });

    it('does not rewrite teams with no pending agents', () => {
      const allHandlers = new Map<string, (args: readonly unknown[]) => unknown[]>();
      allHandlers.set('SELECT id, agents FROM teams', () => [
        {
          id: 'team-a',
          agents: JSON.stringify([{ slotId: 'a', agentName: 'A', status: 'idle' }]),
        },
      ]);
      const { driver, captured } = makeRecordingDriver({ allHandlers });
      v57!.up(driver);

      const updates = captured.runs.filter((r) => r.sql.startsWith('UPDATE teams SET agents'));
      expect(updates).toHaveLength(0);
    });
  });

  describe('migration v58 — retention-aware activity_log trigger', () => {
    const v58 = ALL_MIGRATIONS.find((m) => m.version === 58);

    it('drops the blanket immutable trigger and creates a 7-day retention trigger', () => {
      expect(v58).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v58!.up(driver);

      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TRIGGER IF EXISTS prevent_activity_log_delete');
      expect(joined).toContain('prevent_activity_log_delete_recent');
      expect(joined).toMatch(/7 \* 24 \* 60 \* 60 \* 1000/);
    });

    it('down() restores the original immutable trigger', () => {
      const { driver, captured } = makeRecordingDriver();
      v58!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TRIGGER IF EXISTS prevent_activity_log_delete_recent');
      expect(joined).toContain('activity_log is immutable');
    });
  });

  describe('migration v59 — composite indexes', () => {
    const v59 = ALL_MIGRATIONS.find((m) => m.version === 59);

    it('creates both composite indexes', () => {
      expect(v59).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v59!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('idx_activity_log_user_entity_date');
      expect(joined).toContain('idx_sprint_tasks_team_status');
    });

    it('down() drops both indexes', () => {
      const { driver, captured } = makeRecordingDriver();
      v59!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_activity_log_user_entity_date');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_sprint_tasks_team_status');
    });
  });

  describe('migration v60 — fleet_mode_enabled feature flag', () => {
    const v60 = ALL_MIGRATIONS.find((m) => m.version === 60);

    it('seeds fleet_mode_enabled with enabled=1 (ON by default for v1.9.26+)', () => {
      expect(v60).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v60!.up(driver);
      const run = captured.runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO security_feature_toggles'));
      expect(run).toBeDefined();
      expect(run!.args[0]).toBe('fleet_mode_enabled');
    });

    it('uses INSERT OR IGNORE so re-running does not overwrite admin-disabled flags', () => {
      const v60Again = ALL_MIGRATIONS.find((m) => m.version === 60);
      const { driver, captured } = makeRecordingDriver();
      v60Again!.up(driver);
      const inserts = captured.prepares.filter((s) => s.includes('INSERT OR IGNORE'));
      expect(inserts.length).toBeGreaterThan(0);
    });

    it('down() removes only the fleet flag, not other feature toggles', () => {
      const { driver, captured } = makeRecordingDriver();
      v60!.down(driver);
      const del = captured.runs.find((r) => r.sql.includes('DELETE FROM security_feature_toggles WHERE feature'));
      expect(del).toBeDefined();
      expect(del!.args[0]).toBe('fleet_mode_enabled');
    });
  });
});
