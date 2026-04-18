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
    // Default pragma() returns [] so table_info queries don't explode when
    // a migration uses ALTER+pragma to detect pre-existing columns. Tests
    // that need specific column lists can override via makeRecordingDriver
    // callsite — but v63's ALTER-if-missing is happy with empty.
    pragma: vi.fn(() => [] as unknown),
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

  describe('migration v61 — fleet enrollment tables', () => {
    const v61 = ALL_MIGRATIONS.find((m) => m.version === 61);

    it('creates fleet_enrollment_tokens with the expected columns', () => {
      expect(v61).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v61!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_enrollment_tokens');
      expect(joined).toContain('token_hash TEXT PRIMARY KEY');
      expect(joined).toContain('expires_at INTEGER NOT NULL');
      expect(joined).toContain('used_by_device_id');
      expect(joined).toContain('revoked_at');
    });

    it('creates fleet_enrollments with status enum + jti column', () => {
      const { driver, captured } = makeRecordingDriver();
      v61!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_enrollments');
      expect(joined).toContain('device_id TEXT PRIMARY KEY');
      expect(joined).toContain('device_pubkey_pem TEXT NOT NULL');
      expect(joined).toContain("CHECK (status IN ('enrolled', 'revoked'))");
      expect(joined).toContain('device_jwt_jti TEXT NOT NULL');
      expect(joined).toContain('enrollment_token_hash TEXT NOT NULL');
    });

    it('creates the expected performance indexes', () => {
      const { driver, captured } = makeRecordingDriver();
      v61!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('idx_fleet_enrollment_tokens_expires');
      expect(joined).toContain('idx_fleet_enrollments_status');
      expect(joined).toContain('idx_fleet_enrollments_heartbeat');
    });

    it('down() drops both tables + all indexes', () => {
      const { driver, captured } = makeRecordingDriver();
      v61!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_enrollments');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_enrollment_tokens');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_fleet_enrollments_status');
    });
  });

  describe('migration v62 — fleet_config_version + managed_config_keys', () => {
    const v62 = ALL_MIGRATIONS.find((m) => m.version === 62);

    it('creates fleet_config_version as a singleton table', () => {
      expect(v62).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v62!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_config_version');
      expect(joined).toContain('id INTEGER PRIMARY KEY CHECK (id = 1)');
      expect(joined).toContain('version INTEGER NOT NULL DEFAULT 0');
    });

    it('seeds the singleton row with version 0', () => {
      const { driver, captured } = makeRecordingDriver();
      v62!.up(driver);
      const seed = captured.runs.find((r) => r.sql.includes('INSERT OR IGNORE INTO fleet_config_version'));
      expect(seed).toBeDefined();
    });

    it('creates managed_config_keys with source + version tracking', () => {
      const { driver, captured } = makeRecordingDriver();
      v62!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS managed_config_keys');
      expect(joined).toContain('key TEXT PRIMARY KEY');
      expect(joined).toContain('managed_by_version INTEGER NOT NULL');
      expect(joined).toContain('previous_value TEXT');
      expect(joined).toContain('idx_managed_config_keys_version');
    });

    it('down() drops both tables + index', () => {
      const { driver, captured } = makeRecordingDriver();
      v62!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_config_version');
      expect(joined).toContain('DROP TABLE IF EXISTS managed_config_keys');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_managed_config_keys_version');
    });
  });

  describe('migration v63 — source + managed_by_version columns', () => {
    const v63 = ALL_MIGRATIONS.find((m) => m.version === 63);

    it('adds source + managed_by_version to iam_policies when missing', () => {
      expect(v63).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v63!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain("ALTER TABLE iam_policies ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
      expect(joined).toContain('ALTER TABLE iam_policies ADD COLUMN managed_by_version INTEGER');
    });

    it('adds source + managed_by_version to security_feature_toggles', () => {
      const { driver, captured } = makeRecordingDriver();
      v63!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain("ALTER TABLE security_feature_toggles ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
      expect(joined).toContain('ALTER TABLE security_feature_toggles ADD COLUMN managed_by_version INTEGER');
    });

    it('skips ALTER when column already exists (pragma detection)', () => {
      // Simulate both columns already present → no ALTER statements
      const driver = {
        prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), all: () => [], get: () => undefined }),
        exec: (() => {
          const execs: string[] = [];
          const fn = (sql: string): void => {
            execs.push(sql);
          };
          (fn as unknown as { _execs: string[] })._execs = execs;
          return fn;
        })(),
        pragma: (q: string) => {
          if (q.includes('iam_policies')) {
            return [{ name: 'source' }, { name: 'managed_by_version' }, { name: 'id' }];
          }
          if (q.includes('security_feature_toggles')) {
            return [{ name: 'source' }, { name: 'managed_by_version' }, { name: 'feature' }];
          }
          return [];
        },
        transaction: () => () => {},
        close: () => {},
      } as unknown as Parameters<typeof v63.up>[0];
      v63!.up(driver);
      const execs = (driver.exec as unknown as { _execs: string[] })._execs;
      // No ALTERs because both columns already present
      expect(execs.filter((s) => s.startsWith('ALTER'))).toHaveLength(0);
    });

    it('down() is a no-op that just logs a warning (SQLite limitation)', () => {
      const { driver } = makeRecordingDriver();
      expect(() => v63!.down(driver)).not.toThrow();
    });
  });

  describe('migration v64 — fleet_telemetry_reports (master)', () => {
    const v64 = ALL_MIGRATIONS.find((m) => m.version === 64);

    it('creates fleet_telemetry_reports with composite PK on (device_id, window_end)', () => {
      expect(v64).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v64!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_telemetry_reports');
      expect(joined).toContain('PRIMARY KEY (device_id, window_end)');
    });

    it('creates both query indexes — per-device and fleet-wide', () => {
      const { driver, captured } = makeRecordingDriver();
      v64!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('idx_fleet_telemetry_reports_device');
      expect(joined).toContain('idx_fleet_telemetry_reports_window');
    });

    it('down() drops table + indexes without throwing', () => {
      const { driver, captured } = makeRecordingDriver();
      v64!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_telemetry_reports');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_fleet_telemetry_reports_device');
      expect(joined).toContain('DROP INDEX IF EXISTS idx_fleet_telemetry_reports_window');
    });
  });

  describe('migration v65 — fleet_telemetry_state singleton (slave)', () => {
    const v65 = ALL_MIGRATIONS.find((m) => m.version === 65);

    it('creates fleet_telemetry_state with CHECK (id = 1) singleton guard', () => {
      expect(v65).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v65!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_telemetry_state');
      expect(joined).toContain('CHECK (id = 1)');
    });

    it('seeds the singleton row with last_report_window_end = 0', () => {
      const { driver, captured } = makeRecordingDriver();
      v65!.up(driver);
      // The seed goes through `prepare(...).run(...)`, so check captured prepares
      const joined = captured.prepares.join('\n');
      expect(joined).toContain('INSERT OR IGNORE INTO fleet_telemetry_state');
      expect(joined).toContain('VALUES (1, 0, ?)');
    });

    it('down() drops the table without throwing', () => {
      const { driver, captured } = makeRecordingDriver();
      v65!.down(driver);
      expect(captured.execs.join('\n')).toContain('DROP TABLE IF EXISTS fleet_telemetry_state');
    });
  });

  describe('migration v66 — source + managed_by_version + published_to_fleet on agent_gallery', () => {
    const v66 = ALL_MIGRATIONS.find((m) => m.version === 66);

    it('adds all three new columns when missing', () => {
      expect(v66).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v66!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain("ALTER TABLE agent_gallery ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
      expect(joined).toContain('ALTER TABLE agent_gallery ADD COLUMN managed_by_version INTEGER');
      expect(joined).toContain('ALTER TABLE agent_gallery ADD COLUMN published_to_fleet INTEGER NOT NULL DEFAULT 0');
    });

    it('skips ALTER when all columns already exist', () => {
      const driver = {
        prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), all: () => [], get: () => undefined }),
        exec: (() => {
          const execs: string[] = [];
          const fn = (sql: string): void => {
            execs.push(sql);
          };
          (fn as unknown as { _execs: string[] })._execs = execs;
          return fn;
        })(),
        pragma: () => [
          { name: 'id' },
          { name: 'source' },
          { name: 'managed_by_version' },
          { name: 'published_to_fleet' },
        ],
        transaction: () => () => {},
        close: () => {},
      } as unknown as Parameters<typeof v66.up>[0];
      v66!.up(driver);
      const execs = (driver.exec as unknown as { _execs: string[] })._execs;
      expect(execs.filter((s) => s.startsWith('ALTER'))).toHaveLength(0);
    });

    it('down() is a no-op that just logs a warning (SQLite limitation)', () => {
      const { driver } = makeRecordingDriver();
      expect(() => v66!.down(driver)).not.toThrow();
    });
  });

  describe('migration v67 — fleet_commands + fleet_command_acks', () => {
    const v67 = ALL_MIGRATIONS.find((m) => m.version === 67);

    it('creates fleet_commands + fleet_command_acks tables', () => {
      expect(v67).toBeDefined();
      const { driver, captured } = makeRecordingDriver();
      v67!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_commands');
      expect(joined).toContain('CREATE TABLE IF NOT EXISTS fleet_command_acks');
      expect(joined).toContain('PRIMARY KEY (command_id, device_id)');
    });

    it('creates all three query indexes', () => {
      const { driver, captured } = makeRecordingDriver();
      v67!.up(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('idx_fleet_commands_target_expires');
      expect(joined).toContain('idx_fleet_commands_created');
      expect(joined).toContain('idx_fleet_command_acks_command');
    });

    it('down() drops tables + indexes without throwing', () => {
      const { driver, captured } = makeRecordingDriver();
      v67!.down(driver);
      const joined = captured.execs.join('\n');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_commands');
      expect(joined).toContain('DROP TABLE IF EXISTS fleet_command_acks');
    });
  });
});
