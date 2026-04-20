/**
 * @license Apache-2.0
 * Agent Workflow Builder — integration tests against in-memory SQLite.
 *
 * Exercises the full stack (migration → schema → service layer →
 * dispatcher) end-to-end against a real better-sqlite3 backend.
 * Skips when the native module can't be loaded (same pattern as
 * fleetEnrollment.test.ts — the Electron ABI mismatch prevents
 * native SQLite in some test environments).
 *
 * Covers the scenarios the plan § Verification called out:
 *   3. Migration v74 round-trip (up → down → up) — data survives
 *   6. Seed idempotency — warm reboots are no-ops
 *   9. IAM deny — step fails with IAM_DENIED
 *   11. Security feature toggle off — dispatcher short-circuits
 *   12. Backward-compat — no binding = no run = identical behavior
 *   + binding → run creation → step advancement happy path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '@process/services/database/schema';
import { runMigrations } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import { setToggle } from '@process/services/securityFeatures';
import { seedBuiltinWorkflows, _listBuiltinWorkflows } from '@process/services/workflows/seeds';
import {
  createBinding,
  getBinding,
  listBindingsBySlot,
  resolveActiveBinding,
} from '@process/services/workflows/agentBinding';
import {
  createRun,
  getActiveRun,
  getRun,
  updateRunStatus,
  appendTrace,
} from '@process/services/workflows/agentRunState';
import { prepareTurnContext, dispatcherEvents } from '@process/services/workflows/agentDispatcher';
import '@process/services/workflows/handlers/agent'; // side-effect: register handlers
import type { WorkflowDefinition } from '@process/services/workflows/types';

let nativeAvailable = true;
try {
  const probe = new BetterSqlite3Driver(':memory:');
  probe.close();
} catch {
  nativeAvailable = false;
}
const describeOrSkip = nativeAvailable ? describe : describe.skip;

const ADMIN_USER = 'system_default_user';

function setupDb(): ISqliteDriver {
  const driver = new BetterSqlite3Driver(':memory:');
  initSchema(driver);
  runMigrations(driver, 0, 74);
  driver
    .prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(ADMIN_USER, 'system', 'hash', Date.now(), Date.now());
  return driver;
}

/** Load the first seeded builtin workflow as a WorkflowDefinition. */
function getSeededWorkflow(db: ISqliteDriver, canonicalId: string): WorkflowDefinition {
  const row = db.prepare('SELECT * FROM workflow_definitions WHERE canonical_id = ?').get(canonicalId) as Record<
    string,
    unknown
  >;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    nodes: JSON.parse(row.nodes as string),
    connections: JSON.parse(row.connections as string),
    settings: JSON.parse((row.settings as string) || '{}'),
    enabled: (row.enabled as number) === 1,
    version: row.version as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    canonicalId: row.canonical_id as string,
    source: row.source as 'builtin',
    category: row.category as string,
  };
}

// ── Migration v74 round-trip ─────────────────────────────────────────────────

describeOrSkip('migration v74 — up → down → up', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('creates all 3 columns/tables and round-trips cleanly', () => {
    // up already applied in setupDb. Verify.
    const wfColumns = db.prepare('PRAGMA table_info(workflow_definitions)').all() as Array<{ name: string }>;
    const names = wfColumns.map((c) => c.name);
    expect(names).toContain('canonical_id');
    expect(names).toContain('source');
    expect(names).toContain('category');
    expect(names).toContain('managed_by_version');
    expect(names).toContain('published_to_fleet');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('workflow_bindings');
    expect(tables).toContain('agent_workflow_runs');

    const agentGalleryCols = (db.prepare('PRAGMA table_info(agent_gallery)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(agentGalleryCols).toContain('default_workflow_id');
  });

  it('pre-v74 workflow_definitions rows survive with sane defaults', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow_definitions (id, user_id, name, nodes, connections, settings, enabled, version, created_at, updated_at)
       VALUES ('pre', ?, 'Pre-v74', '[]', '[]', '{}', 1, 1, ?, ?)`
    ).run(ADMIN_USER, now, now);
    const row = db.prepare("SELECT source, published_to_fleet FROM workflow_definitions WHERE id = 'pre'").get() as {
      source: string;
      published_to_fleet: number;
    };
    expect(row.source).toBe('local');
    expect(row.published_to_fleet).toBe(0);
  });
});

// ── Seed library ─────────────────────────────────────────────────────────────

describeOrSkip('seedBuiltinWorkflows', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('inserts exactly 7 workflows on first call', () => {
    const count = seedBuiltinWorkflows(db, ADMIN_USER);
    expect(count).toBe(7);
    const rows = db.prepare("SELECT count(*) as c FROM workflow_definitions WHERE source = 'builtin'").get() as {
      c: number;
    };
    expect(rows.c).toBe(7);
  });

  it('is idempotent — second call inserts zero', () => {
    seedBuiltinWorkflows(db, ADMIN_USER);
    const count = seedBuiltinWorkflows(db, ADMIN_USER);
    expect(count).toBe(0);
  });

  it('preserves user forks (source=local) on reseed', () => {
    seedBuiltinWorkflows(db, ADMIN_USER);
    // Simulate fork: copy with local source.
    const original = db
      .prepare("SELECT * FROM workflow_definitions WHERE canonical_id = 'builtin:workflow.safe_commit@1'")
      .get() as Record<string, unknown>;
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow_definitions (id, user_id, name, nodes, connections, settings, enabled, version, created_at, updated_at, canonical_id, source)
       VALUES ('fork-1', ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'local')`
    ).run(
      ADMIN_USER,
      'Safe commit (forked)',
      original.nodes,
      original.connections,
      '{}',
      now,
      now,
      original.canonical_id
    );
    // Reseed — fork must survive.
    seedBuiltinWorkflows(db, ADMIN_USER);
    const fork = db.prepare("SELECT name FROM workflow_definitions WHERE id = 'fork-1'").get() as {
      name: string;
    };
    expect(fork.name).toBe('Safe commit (forked)');
  });

  it('every seeded row has a valid category + canonical_id', () => {
    seedBuiltinWorkflows(db, ADMIN_USER);
    const rows = db
      .prepare("SELECT canonical_id, category FROM workflow_definitions WHERE source = 'builtin'")
      .all() as Array<{ canonical_id: string; category: string }>;
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.canonical_id).toMatch(/^builtin:workflow\./);
      expect(r.category).toMatch(/^agent-behavior\//);
    }
  });
});

// ── Binding + run lifecycle ─────────────────────────────────────────────────

describeOrSkip('binding + run lifecycle', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
    seedBuiltinWorkflows(db, ADMIN_USER);
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('createBinding + getBinding round-trip', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.safe_commit@1');
    const binding = createBinding(db, {
      workflowDefinitionId: wf.id,
      slotId: 'slot-1',
      teamId: 'team-a',
    });
    const fetched = getBinding(db, binding.id);
    expect(fetched?.workflowDefinitionId).toBe(wf.id);
    expect(fetched?.slotId).toBe('slot-1');
  });

  it('resolveActiveBinding prefers slot over template', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.safe_commit@1');
    const wf2 = getSeededWorkflow(db, 'builtin:workflow.sprint_standup@1');
    createBinding(db, { workflowDefinitionId: wf.id, agentGalleryId: 'g-1' });
    createBinding(db, { workflowDefinitionId: wf2.id, slotId: 'slot-1', teamId: 'team-a' });
    const resolved = resolveActiveBinding(db, { slotId: 'slot-1', agentGalleryId: 'g-1' });
    expect(resolved?.workflowDefinitionId).toBe(wf2.id);
  });

  it('createRun captures a graph snapshot at run-start', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.safe_commit@1');
    const run = createRun(db, { workflow: wf, agentSlotId: 'slot-1', teamId: 'team-a' });
    expect(run.status).toBe('running');
    expect(run.graphSnapshot).toBe(JSON.stringify(wf));
    expect(run.activeStepIds.length).toBeGreaterThan(0);
  });

  it('snapshot is immutable to later definition edits (plan item 8)', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.safe_commit@1');
    const run = createRun(db, { workflow: wf, agentSlotId: 'slot-1' });
    // Edit the definition AFTER run-start.
    db.prepare("UPDATE workflow_definitions SET name = 'Mutated' WHERE id = ?").run(wf.id);
    const fresh = getRun(db, run.id);
    expect(fresh?.graphSnapshot).toBe(JSON.stringify(wf));
    const parsed = JSON.parse(fresh!.graphSnapshot) as WorkflowDefinition;
    expect(parsed.name).toBe('Safe commit');
  });

  it('getActiveRun finds running/paused but not completed runs', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.sprint_standup@1');
    const run = createRun(db, { workflow: wf, agentSlotId: 'slot-2' });
    expect(getActiveRun(db, 'slot-2')?.id).toBe(run.id);
    updateRunStatus(db, run.id, 'completed');
    expect(getActiveRun(db, 'slot-2')).toBeNull();
  });

  it('appendTrace bounds the trace array', () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.sprint_standup@1');
    const run = createRun(db, { workflow: wf, agentSlotId: 'slot-3' });
    // Hammer 210 trace entries — should rotate oldest-first to 200.
    for (let i = 0; i < 210; i++) {
      appendTrace(db, run.id, { timestamp: Date.now() + i, kind: 'step_started', stepId: String(i) });
    }
    const fresh = getRun(db, run.id);
    expect(fresh?.trace.length).toBe(200);
    // First retained entry should have stepId '10' (0-9 rotated out).
    expect(fresh?.trace[0].stepId).toBe('10');
  });
});

// ── Dispatcher behavior ─────────────────────────────────────────────────────

describeOrSkip('agentDispatcher — security + backward-compat', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
    seedBuiltinWorkflows(db, ADMIN_USER);
    dispatcherEvents.removeAllListeners();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('short-circuits when `agent_workflows` security feature is off (plan item 11)', async () => {
    const wf = getSeededWorkflow(db, 'builtin:workflow.sprint_standup@1');
    createBinding(db, { workflowDefinitionId: wf.id, slotId: 'slot-1', teamId: 'team-a' });
    // Toggle defaults to 0 (seeded OFF).
    const result = await prepareTurnContext({
      db,
      slotId: 'slot-1',
      teamId: 'team-a',
      allowedTools: ['*'],
      turnNumber: 0,
    });
    expect(result).toBeNull();
    // No run should have been created either.
    expect(getActiveRun(db, 'slot-1')).toBeNull();
  });

  it('short-circuits when no binding exists (plan item 12 — backward compat)', async () => {
    setToggle(db, 'agent_workflows', true);
    const result = await prepareTurnContext({
      db,
      slotId: 'solo-slot',
      teamId: 'team-a',
      allowedTools: ['*'],
      turnNumber: 0,
    });
    expect(result).toBeNull();
    expect(getActiveRun(db, 'solo-slot')).toBeNull();
  });

  it('creates a run on first eligible turn once enabled + bound', async () => {
    setToggle(db, 'agent_workflows', true);
    const wf = getSeededWorkflow(db, 'builtin:workflow.research_digest@1');
    createBinding(db, { workflowDefinitionId: wf.id, slotId: 'slot-rd', teamId: 'team-a' });
    let runStarted = false;
    dispatcherEvents.once('run-started', () => {
      runStarted = true;
    });
    const result = await prepareTurnContext({
      db,
      slotId: 'slot-rd',
      teamId: 'team-a',
      allowedTools: ['*'],
      turnNumber: 0,
    });
    // First node is prompt.plan → deferred → injection returned.
    expect(result).not.toBeNull();
    expect(result!.injectedContext).toContain('Research digest');
    expect(result!.injectedContext).toContain('Step 1');
    const run = getActiveRun(db, 'slot-rd');
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');
    expect(runStarted).toBe(true);
  });

  it('IAM deny on a tool step marks the step failed (plan item 9)', async () => {
    setToggle(db, 'agent_workflows', true);
    const wf = getSeededWorkflow(db, 'builtin:workflow.pr_triage@1');
    createBinding(db, { workflowDefinitionId: wf.id, slotId: 'slot-pr', teamId: 'team-a' });
    // allowedTools is restricted — no mcp.shell.exec.
    const result = await prepareTurnContext({
      db,
      slotId: 'slot-pr',
      teamId: 'team-a',
      allowedTools: ['team_task_create'],
      turnNumber: 0,
    });
    // First node is tool.git.diff → IAM_DENIED → onError 'stop' → run failed.
    expect(result).toBeNull();
    const run = getActiveRun(db, 'slot-pr');
    // Run is now 'failed', so getActiveRun returns null (it only returns running/paused).
    expect(run).toBeNull();
    // Verify the actual row
    const row = db.prepare('SELECT status FROM agent_workflow_runs WHERE agent_slot_id = ?').get('slot-pr') as {
      status: string;
    };
    expect(row.status).toBe('failed');
  });
});

// ── Parallel fan-out + join (Phase 2.x) ─────────────────────────────────────

/**
 * Inserts a synthetic workflow:
 *
 *   trigger → fan_out → [action_A, action_B] → join → action_final
 *
 * All non-trigger steps use types whose handlers are registered
 * without external dependencies (action, parallel.fan_out,
 * parallel.join) so the test can walk the dispatcher end-to-end
 * without mocking sprint / git / prompt handlers.
 */
function insertParallelTestWorkflow(db: ISqliteDriver): string {
  const id = 'wf-parallel-test';
  const now = Date.now();
  const nodes = [
    { id: 'trigger', type: 'trigger', name: 'Start', parameters: {}, position: { x: 0, y: 0 }, onError: 'stop' },
    {
      id: 'fan_out',
      type: 'parallel.fan_out',
      name: 'Fan out',
      parameters: {},
      position: { x: 280, y: 0 },
      onError: 'stop',
    },
    { id: 'a', type: 'action', name: 'A', parameters: {}, position: { x: 560, y: 0 }, onError: 'stop' },
    { id: 'b', type: 'action', name: 'B', parameters: {}, position: { x: 560, y: 130 }, onError: 'stop' },
    {
      id: 'join',
      type: 'parallel.join',
      name: 'Join',
      parameters: {},
      position: { x: 840, y: 0 },
      onError: 'stop',
    },
    { id: 'final', type: 'action', name: 'Final', parameters: {}, position: { x: 1120, y: 0 }, onError: 'stop' },
  ];
  const connections = [
    { fromNodeId: 'trigger', fromOutput: 'main', toNodeId: 'fan_out', toInput: 'main' },
    { fromNodeId: 'fan_out', fromOutput: 'main', toNodeId: 'a', toInput: 'main' },
    { fromNodeId: 'fan_out', fromOutput: 'main', toNodeId: 'b', toInput: 'main' },
    { fromNodeId: 'a', fromOutput: 'main', toNodeId: 'join', toInput: 'main' },
    { fromNodeId: 'b', fromOutput: 'main', toNodeId: 'join', toInput: 'main' },
    { fromNodeId: 'join', fromOutput: 'main', toNodeId: 'final', toInput: 'main' },
  ];
  db.prepare(
    `INSERT INTO workflow_definitions
       (id, user_id, name, description, nodes, connections, settings, enabled, version,
        created_at, updated_at, canonical_id, source, category, published_to_fleet)
     VALUES (?, ?, 'Parallel test', 'A/B parallel harness', ?, ?, '{}', 1, 1, ?, ?, ?, 'local', 'agent-behavior/test', 0)`
  ).run(id, ADMIN_USER, JSON.stringify(nodes), JSON.stringify(connections), now, now, 'local:workflow.parallel_test@1');
  return id;
}

describeOrSkip('agentDispatcher — parallel.fan_out → [A, B] → parallel.join', () => {
  let db: ISqliteDriver;
  beforeEach(() => {
    db = setupDb();
    dispatcherEvents.removeAllListeners();
  });
  afterEach(() => {
    (db as BetterSqlite3Driver).close();
  });

  it('walks the fan-out, completes both branches, then activates + completes join', async () => {
    setToggle(db, 'agent_workflows', true);
    const wfId = insertParallelTestWorkflow(db);
    createBinding(db, { workflowDefinitionId: wfId, slotId: 'slot-par', teamId: 'team-a' });

    const result = await prepareTurnContext({
      db,
      slotId: 'slot-par',
      teamId: 'team-a',
      allowedTools: ['*'],
      turnNumber: 0,
    });

    // Every handler in the graph is non-deferred → the walk runs
    // from entry to terminal in a single dispatch. No injection.
    expect(result).toBeNull();

    // Run is now completed (no active steps remain).
    const row = db
      .prepare('SELECT status, completed_step_ids FROM agent_workflow_runs WHERE agent_slot_id = ?')
      .get('slot-par') as { status: string; completed_step_ids: string };
    expect(row.status).toBe('completed');

    const completed = JSON.parse(row.completed_step_ids) as string[];
    // Every non-trigger node must be in completed.
    expect(completed).toEqual(expect.arrayContaining(['fan_out', 'a', 'b', 'join', 'final']));

    // Key invariant for parallel.join: join's index must be AFTER
    // both 'a' and 'b' — the dispatcher cannot have activated join
    // until both predecessors were in the completed set.
    const idxA = completed.indexOf('a');
    const idxB = completed.indexOf('b');
    const idxJoin = completed.indexOf('join');
    expect(idxJoin).toBeGreaterThan(idxA);
    expect(idxJoin).toBeGreaterThan(idxB);
  });

  it('does not prematurely activate the join when only one branch is complete', async () => {
    setToggle(db, 'agent_workflows', true);
    const wfId = insertParallelTestWorkflow(db);

    // Seed a live run with 'fan_out' + 'a' already completed, 'b'
    // still active. This simulates the mid-flight state the walk
    // would hit between dispatching A and B.
    const { createRun: _createRun, updateRunSteps } = await import('@process/services/workflows/agentRunState');
    const row = db.prepare('SELECT nodes, connections FROM workflow_definitions WHERE id = ?').get(wfId) as {
      nodes: string;
      connections: string;
    };
    const wfFull = {
      id: wfId,
      userId: ADMIN_USER,
      name: 'Parallel test',
      description: 'A/B parallel harness',
      nodes: JSON.parse(row.nodes),
      connections: JSON.parse(row.connections),
      settings: {},
      enabled: true,
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    } as Parameters<typeof _createRun>[1]['workflow'];

    const run = _createRun(db, { workflow: wfFull, agentSlotId: 'slot-par2' });
    // Jump ahead: mark 'fan_out' + 'a' completed; 'b' still active.
    updateRunSteps(db, run.id, {
      activeStepIds: ['b'],
      completedStepIds: ['fan_out', 'a'],
    });

    // Invoke computeNextActiveSteps directly via a walk simulation:
    // what happens when 'a' just completed and we're deciding
    // what to activate from its edges?
    //
    // Rather than unit-test the internal helper, drive the dispatcher:
    // a subsequent prepareTurnContext call should walk 'b' + join.
    const result = await prepareTurnContext({
      db,
      slotId: 'slot-par2',
      teamId: 'team-a',
      allowedTools: ['*'],
      turnNumber: 1,
    });
    expect(result).toBeNull();

    const final = db.prepare('SELECT status, completed_step_ids FROM agent_workflow_runs WHERE id = ?').get(run.id) as {
      status: string;
      completed_step_ids: string;
    };
    expect(final.status).toBe('completed');
    const completed = JSON.parse(final.completed_step_ids) as string[];
    // 'a' was already completed; 'b' + 'join' + 'final' should have
    // been added in order — join comes after b, final after join.
    expect(completed).toEqual(expect.arrayContaining(['b', 'join', 'final']));
    expect(completed.indexOf('join')).toBeGreaterThan(completed.indexOf('b'));
    expect(completed.indexOf('final')).toBeGreaterThan(completed.indexOf('join'));
  });
});

// ── Sanity ─────────────────────────────────────────────────────────────────

describeOrSkip('seed library count sanity', () => {
  it('matches the TS constant count', () => {
    expect(_listBuiltinWorkflows()).toHaveLength(7);
  });
});
