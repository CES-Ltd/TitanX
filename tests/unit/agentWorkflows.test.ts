/**
 * @license Apache-2.0
 * Agent Workflow Builder — unit tests (v2.6.0 Phase 1).
 *
 * Covers the pure-function surface + lock semantics + binding CRUD
 * precedence without requiring the native better-sqlite3 build. DB
 * calls use a recording stub driver (mirrors the pattern in
 * DatabaseMigrations.test.ts) — every SQL statement is captured so
 * we assert shape, not backend.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ISqliteDriver, IStatement } from '@process/services/database/drivers/ISqliteDriver';
import { AgentWorkflowBusyGuard } from '@process/services/workflows/AgentWorkflowBusyGuard';
import {
  AGENT_CONTEXT_KEY,
  renderPromptTemplate,
  type HandlerAgentContext,
} from '@process/services/workflows/handlers/agent/promptHandlers';
import { findEntryStepIds } from '@process/services/workflows/agentRunState';
import { resolveActiveBinding } from '@process/services/workflows/agentBinding';
import { _listBuiltinWorkflows } from '@process/services/workflows/seeds';
import { ALL_MIGRATIONS } from '@process/services/database/migrations';
import { getRegisteredHandler } from '@process/services/workflows/engine';
import '@process/services/workflows/handlers/agent'; // side-effect: register every handler
import type { WorkflowConnection, WorkflowNode } from '@process/services/workflows/types';

/**
 * Build a lightweight recording driver with configurable row results.
 * `rowsBySql` is consulted for `.all(...)` calls — the first matching
 * prefix returns the rows. Everything else returns empty.
 */
function makeStubDriver(rowsBySql: Record<string, unknown[]> = {}): {
  driver: ISqliteDriver;
  execs: string[];
  prepares: string[];
  runs: Array<{ sql: string; args: readonly unknown[] }>;
} {
  const execs: string[] = [];
  const prepares: string[] = [];
  const runs: Array<{ sql: string; args: readonly unknown[] }> = [];

  const driver: ISqliteDriver = {
    prepare(sql: string): IStatement {
      prepares.push(sql);
      return {
        run: (...args: unknown[]) => {
          runs.push({ sql, args });
          return { changes: 1, lastInsertRowid: 1 };
        },
        get: (..._args: unknown[]) => {
          for (const key of Object.keys(rowsBySql)) {
            if (sql.includes(key)) return rowsBySql[key][0];
          }
          return undefined;
        },
        all: (..._args: unknown[]) => {
          for (const key of Object.keys(rowsBySql)) {
            if (sql.includes(key)) return rowsBySql[key];
          }
          return [];
        },
      };
    },
    exec(sql: string) {
      execs.push(sql);
    },
    pragma() {
      return null;
    },
    transaction(fn) {
      return fn;
    },
    close() {},
  };

  return { driver, execs, prepares, runs };
}

// ── findEntryStepIds ─────────────────────────────────────────────────────────

describe('findEntryStepIds', () => {
  const makeNode = (id: string, type: WorkflowNode['type']): WorkflowNode => ({
    id,
    type,
    name: id,
    parameters: {},
    position: { x: 0, y: 0 },
    onError: 'stop',
  });
  const edge = (from: string, to: string): WorkflowConnection => ({
    fromNodeId: from,
    fromOutput: 'main',
    toNodeId: to,
    toInput: 'main',
  });

  it('returns the lone non-trigger source node', () => {
    const nodes = [makeNode('t', 'trigger'), makeNode('a', 'prompt.plan')];
    const conns = [edge('t', 'a')];
    expect(findEntryStepIds(nodes, conns)).toEqual(['a']);
  });

  it('treats nodes with no upstream as entry steps', () => {
    const nodes = [makeNode('a', 'prompt.plan'), makeNode('b', 'prompt.freeform')];
    expect(findEntryStepIds(nodes, [])).toEqual(['a', 'b']);
  });

  it('excludes trigger + webhook types from the returned set', () => {
    const nodes = [makeNode('t', 'trigger'), makeNode('w', 'webhook'), makeNode('a', 'prompt.plan')];
    const conns = [edge('t', 'a'), edge('w', 'a')];
    expect(findEntryStepIds(nodes, conns)).toEqual(['a']);
  });

  it('handles empty nodes/connections', () => {
    expect(findEntryStepIds([], [])).toEqual([]);
  });
});

// ── renderPromptTemplate ─────────────────────────────────────────────────────

describe('renderPromptTemplate', () => {
  it('substitutes {{var.X}} from the state bag', () => {
    expect(renderPromptTemplate('Hello {{var.name}}', { name: 'world' })).toBe('Hello world');
  });
  it('supports dotted paths', () => {
    expect(renderPromptTemplate('{{var.user.first}}', { user: { first: 'Ada' } })).toBe('Ada');
  });
  it('leaves unresolved tokens visible', () => {
    expect(renderPromptTemplate('{{var.missing}}', {})).toBe('{{var.missing}}');
  });
  it('passes through strings without tokens', () => {
    expect(renderPromptTemplate('Plain text', { x: 1 })).toBe('Plain text');
  });
});

// ── AgentWorkflowBusyGuard ───────────────────────────────────────────────────

describe('AgentWorkflowBusyGuard', () => {
  let guard: AgentWorkflowBusyGuard;
  beforeEach(() => {
    guard = new AgentWorkflowBusyGuard();
  });

  it('starts idle and flips to dispatching', () => {
    expect(guard.isDispatching('slot-a')).toBe(false);
    guard.setDispatching('slot-a', true);
    expect(guard.isDispatching('slot-a')).toBe(true);
  });

  it('isolates slots from each other', () => {
    guard.setDispatching('slot-a', true);
    expect(guard.isDispatching('slot-b')).toBe(false);
  });

  it('onceIdle fires immediately when already idle', () => {
    let fired = false;
    guard.onceIdle('slot-a', () => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  it('onceIdle queues when dispatching and fires on release', () => {
    guard.setDispatching('slot-a', true);
    const order: string[] = [];
    guard.onceIdle('slot-a', () => order.push('first'));
    guard.onceIdle('slot-a', () => order.push('second'));
    expect(order).toEqual([]);
    guard.setDispatching('slot-a', false);
    expect(order).toEqual(['first', 'second']);
  });

  it('remove clears both state + pending callbacks', () => {
    guard.setDispatching('slot-a', true);
    guard.onceIdle('slot-a', () => {
      throw new Error('should not fire');
    });
    guard.remove('slot-a');
    expect(guard.isDispatching('slot-a')).toBe(false);
  });
});

// ── resolveActiveBinding precedence ─────────────────────────────────────────

describe('resolveActiveBinding', () => {
  it('returns slot-level binding when present', () => {
    const slotRow = {
      id: 'b1',
      workflow_definition_id: 'wf-1',
      slot_id: 'slot-a',
      agent_gallery_id: null,
      team_id: null,
      bound_at: Date.now(),
      expires_at: null,
    };
    const { driver } = makeStubDriver({
      'FROM workflow_bindings WHERE slot_id = ?': [slotRow],
    });
    const binding = resolveActiveBinding(driver, { slotId: 'slot-a', agentGalleryId: 'g-1' });
    expect(binding?.workflowDefinitionId).toBe('wf-1');
    expect(binding?.slotId).toBe('slot-a');
  });

  it('falls back to template-level binding when no slot binding', () => {
    const templateRow = {
      id: 'b2',
      workflow_definition_id: 'wf-template',
      slot_id: null,
      agent_gallery_id: 'g-1',
      team_id: null,
      bound_at: Date.now(),
      expires_at: null,
    };
    const { driver } = makeStubDriver({
      'FROM workflow_bindings WHERE agent_gallery_id = ?': [templateRow],
    });
    const binding = resolveActiveBinding(driver, { slotId: 'slot-a', agentGalleryId: 'g-1' });
    expect(binding?.workflowDefinitionId).toBe('wf-template');
  });

  it('returns null when neither scope is bound (backward-compat path)', () => {
    const { driver } = makeStubDriver({});
    const binding = resolveActiveBinding(driver, { slotId: 'slot-a', agentGalleryId: 'g-1' });
    expect(binding).toBeNull();
  });

  it('filters expired bindings', () => {
    const expiredRow = {
      id: 'b3',
      workflow_definition_id: 'wf-old',
      slot_id: 'slot-a',
      agent_gallery_id: null,
      team_id: null,
      bound_at: Date.now() - 86400000,
      expires_at: Date.now() - 3600000,
    };
    const { driver } = makeStubDriver({
      'FROM workflow_bindings WHERE slot_id = ?': [expiredRow],
    });
    const binding = resolveActiveBinding(driver, { slotId: 'slot-a' });
    expect(binding).toBeNull();
  });
});

// ── Builtin seeds ────────────────────────────────────────────────────────────

describe('_listBuiltinWorkflows', () => {
  it('ships exactly 7 workflows', () => {
    expect(_listBuiltinWorkflows()).toHaveLength(7);
  });

  it('each workflow has a canonical id starting with "builtin:workflow."', () => {
    for (const wf of _listBuiltinWorkflows()) {
      expect(wf.canonicalId).toMatch(/^builtin:workflow\./);
    }
  });

  it('each workflow has at least a trigger node + one action', () => {
    for (const wf of _listBuiltinWorkflows()) {
      expect(wf.nodes.some((n) => n.type === 'trigger')).toBe(true);
      expect(wf.nodes.length).toBeGreaterThan(1);
    }
  });

  it('every connection references a valid node id', () => {
    for (const wf of _listBuiltinWorkflows()) {
      const ids = new Set(wf.nodes.map((n) => n.id));
      for (const conn of wf.connections) {
        expect(ids.has(conn.fromNodeId)).toBe(true);
        expect(ids.has(conn.toNodeId)).toBe(true);
      }
    }
  });
});

// ── Migration v74 presence ──────────────────────────────────────────────────

describe('migration v74', () => {
  it('is registered in ALL_MIGRATIONS', () => {
    const v74 = ALL_MIGRATIONS.find((m) => m.version === 74);
    expect(v74).toBeDefined();
    expect(v74!.name).toContain('Agent Workflow Builder');
  });

  it('creates workflow_bindings + agent_workflow_runs tables', () => {
    const v74 = ALL_MIGRATIONS.find((m) => m.version === 74)!;
    const { driver, execs } = makeStubDriver();
    v74.up(driver);
    const joined = execs.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS workflow_bindings');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS agent_workflow_runs');
  });

  it('extends workflow_definitions with metadata columns', () => {
    const v74 = ALL_MIGRATIONS.find((m) => m.version === 74)!;
    const { driver, execs } = makeStubDriver();
    v74.up(driver);
    const joined = execs.join('\n');
    expect(joined).toContain('canonical_id');
    expect(joined).toContain('source');
    expect(joined).toContain('category');
  });

  it('adds default_workflow_id to agent_gallery', () => {
    const v74 = ALL_MIGRATIONS.find((m) => m.version === 74)!;
    const { driver, execs } = makeStubDriver();
    v74.up(driver);
    expect(execs.some((e) => e.includes('agent_gallery') && e.includes('default_workflow_id'))).toBe(true);
  });
});

// ── Phase 2 extended handlers — non-DB-dependent assertions ─────────────────

/**
 * Helper — build a minimal node + input envelope so we can invoke a
 * handler directly off the shared engine registry.
 */
function makeNodeShim(type: WorkflowNode['type'], parameters: Record<string, unknown> = {}): WorkflowNode {
  return { id: 't', type, name: 't', parameters, position: { x: 0, y: 0 }, onError: 'stop' };
}

function makeInput(state: Record<string, unknown> = {}): Record<string, unknown> {
  const ctx: HandlerAgentContext = { runId: 'r', slotId: 's', state };
  return { [AGENT_CONTEXT_KEY]: ctx };
}

function makeExecCtx(): Parameters<NonNullable<ReturnType<typeof getRegisteredHandler>>>[2] {
  // Minimal ExecutionContext shape — handlers only touch context.db
  // (memory.recall is the sole reader; it gracefully handles a stub).
  return {
    db: {
      prepare: () => ({ run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] }),
    } as unknown as ISqliteDriver,
    executionId: 'e',
    workflowId: 'w',
    nodeOutputs: new Map(),
    cancelled: false,
  };
}

describe('prompt.* handlers (deferred-envelope contract)', () => {
  for (const type of ['prompt.plan', 'prompt.create_todo', 'prompt.review', 'prompt.freeform'] as const) {
    it(`${type} returns a __deferred envelope with a rendered promptTemplate`, async () => {
      const handler = getRegisteredHandler(type);
      expect(handler).toBeDefined();
      const out = await handler!(makeNodeShim(type), makeInput({ module: 'core' }), makeExecCtx());
      expect(out.__deferred).toBe(true);
      expect(typeof out.promptTemplate).toBe('string');
    });
  }

  it('prompt.plan renders {{var.X}} using the agent-context state bag', async () => {
    const handler = getRegisteredHandler('prompt.plan')!;
    const out = await handler(
      makeNodeShim('prompt.plan', { promptTemplate: 'plan for {{var.module}}' }),
      makeInput({ module: 'core' }),
      makeExecCtx()
    );
    expect(out.promptTemplate).toBe('plan for core');
  });

  it('operator-supplied outputSchema is passed through untouched', async () => {
    const schema = { approved: 'boolean', issues: 'string[]' };
    const handler = getRegisteredHandler('prompt.review')!;
    const out = await handler(makeNodeShim('prompt.review', { outputSchema: schema }), makeInput(), makeExecCtx());
    expect(out.outputSchema).toEqual(schema);
  });
});

describe('human.approve handler', () => {
  it('emits a pause envelope with a reason from parameters', async () => {
    const handler = getRegisteredHandler('human.approve')!;
    const out = await handler(
      makeNodeShim('human.approve', { reason: 'Security review required' }),
      makeInput(),
      makeExecCtx()
    );
    expect(out.__pauseReason).toBe('human_approval_required');
    expect(out.__pausePromptTemplate).toBe('Security review required');
    expect(typeof out.pendingAt).toBe('number');
  });

  it('falls back to a default prompt when reason is missing', async () => {
    const handler = getRegisteredHandler('human.approve')!;
    const out = await handler(makeNodeShim('human.approve'), makeInput(), makeExecCtx());
    expect(out.__pauseReason).toBe('human_approval_required');
    expect(typeof out.__pausePromptTemplate).toBe('string');
    expect((out.__pausePromptTemplate as string).length).toBeGreaterThan(0);
  });
});

describe('memory.recall handler', () => {
  it('returns an empty result set when reasoningBank is unavailable / has no hits', async () => {
    const handler = getRegisteredHandler('memory.recall')!;
    const out = await handler(
      makeNodeShim('memory.recall', { query: 'fix bug in core', limit: 3 }),
      makeInput(),
      makeExecCtx()
    );
    // Shape: always { results: [], count?: number } — graceful degradation.
    expect(Array.isArray(out.results)).toBe(true);
  });

  it('returns empty when agent context is missing', async () => {
    const handler = getRegisteredHandler('memory.recall')!;
    const out = await handler(
      makeNodeShim('memory.recall'),
      {} as Record<string, unknown>, // no __agent
      makeExecCtx()
    );
    expect(out.results).toEqual([]);
  });
});

describe('parallel.* handlers', () => {
  it('parallel.fan_out emits __fanOut: true', async () => {
    const handler = getRegisteredHandler('parallel.fan_out')!;
    const out = await handler(makeNodeShim('parallel.fan_out'), makeInput(), makeExecCtx());
    expect(out.__fanOut).toBe(true);
    expect(typeof out.startedAt).toBe('number');
  });

  it('parallel.join emits __join: true', async () => {
    const handler = getRegisteredHandler('parallel.join')!;
    const out = await handler(makeNodeShim('parallel.join'), makeInput(), makeExecCtx());
    expect(out.__join).toBe(true);
    expect(typeof out.joinedAt).toBe('number');
  });
});

describe('acp.slash.invoke handler', () => {
  it('throws when command parameter is missing', async () => {
    const handler = getRegisteredHandler('acp.slash.invoke')!;
    await expect(handler(makeNodeShim('acp.slash.invoke'), makeInput(), makeExecCtx())).rejects.toThrow(/command/);
  });

  it('builds the prompt template as /<command> [args...] with {{var.X}} resolution', async () => {
    const handler = getRegisteredHandler('acp.slash.invoke')!;
    const out = await handler(
      makeNodeShim('acp.slash.invoke', { command: 'compact', args: ['{{var.hint}}'] }),
      makeInput({ hint: 'keep-recent' }),
      makeExecCtx()
    );
    expect(out.__deferred).toBe(true);
    expect(out.promptTemplate).toBe('/compact keep-recent');
  });

  it('accepts a single string for args (coerces to array)', async () => {
    const handler = getRegisteredHandler('acp.slash.invoke')!;
    const out = await handler(
      makeNodeShim('acp.slash.invoke', { command: 'help', args: 'topics' }),
      makeInput(),
      makeExecCtx()
    );
    expect(out.promptTemplate).toBe('/help topics');
  });

  it('omits args cleanly when none supplied', async () => {
    const handler = getRegisteredHandler('acp.slash.invoke')!;
    const out = await handler(makeNodeShim('acp.slash.invoke', { command: 'clear' }), makeInput(), makeExecCtx());
    expect(out.promptTemplate).toBe('/clear');
  });
});
