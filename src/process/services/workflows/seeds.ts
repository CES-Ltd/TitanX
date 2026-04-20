/**
 * @license Apache-2.0
 * Agent Workflow Builder — built-in workflow seeds.
 *
 * Idempotent seeder keyed on `workflow_definitions.canonical_id`.
 * Mirrors `seedBuiltinBlueprints` (blueprints/index.ts:139-165) —
 * same "lookup then insert" pattern, same non-critical activity log
 * when anything landed.
 *
 * Ships 6 workflows as `source='builtin'` / `category='agent-behavior'`:
 *
 *   1. safe_commit@1         — plan → status → diff → review → commit → push
 *   2. pr_triage@1           — diff → review → create_task (on issues)
 *   3. sprint_standup@1      — plan → list → freeform → create_task
 *   4. lead_qualify@1        — plan → create_task
 *   5. content_brief@1       — plan → create_todo → freeform → review
 *   6. research_digest@1     — plan → create_todo → freeform
 *
 * The 6 seeds exercise every Phase 1 handler (prompt.plan, .create_todo,
 * .review, .freeform, tool.git.status/diff/commit/push,
 * sprint.create_task/update_task/list_tasks, plus condition) so the
 * dispatcher path is exercised end-to-end with a fresh install.
 *
 * Phase note on external JSONs: the plan (glittery-enchanting-russell)
 * references `src/process/resources/workflows/*.v1.json`. Phase 1 ships
 * the definitions as TS constants here for speed; Phase 2 can extract
 * them via `JSON.stringify(BUILTIN_WORKFLOWS[0])` into external files
 * when the visual builder needs them as portable artifacts. The
 * serialization shape is identical — just the delivery file format
 * differs.
 *
 * Upgrade semantics (Phase 2/3):
 *
 *   - Each workflow has `managedByVersion: <app_version_int>`. A
 *     future seed upgrade only overwrites a builtin row whose
 *     shipped version is older than the new constant.
 *   - Users who forked a builtin (via `fork-on-edit`) keep their
 *     fork's `source='local'` row untouched — forks have the same
 *     canonicalId but a different row id; the seeder only touches
 *     `source='builtin'`.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import type { WorkflowConnection, WorkflowNode } from './types';

/** App version packed as an integer for comparison (2.6.0 → 260). */
const WORKFLOW_SEED_VERSION = 260;

type BuiltinWorkflow = {
  canonicalId: string;
  name: string;
  description: string;
  /** Gallery-aligned secondary category for UI filtering. */
  subcategory: 'technical' | 'pm' | 'sales' | 'marketing' | 'research';
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
};

/** Compact node builder — keeps the seed definitions readable. */
function node(
  id: string,
  type: WorkflowNode['type'],
  name: string,
  parameters: Record<string, unknown> = {},
  position: { x: number; y: number } = { x: 0, y: 0 }
): WorkflowNode {
  return { id, type, name, parameters, position, onError: 'stop' };
}

function edge(from: string, to: string, fromOutput = 'main', toInput = 'main'): WorkflowConnection {
  return { fromNodeId: from, fromOutput, toNodeId: to, toInput };
}

// ── 1. safe_commit ───────────────────────────────────────────────────────────
const SAFE_COMMIT: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.safe_commit@1',
  name: 'Safe commit',
  description:
    'Plan → git status → diff → self-review → commit → push. Guarded by a review gate so nothing ships without acceptance.',
  subcategory: 'technical',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('plan', 'prompt.plan', 'Plan the commit', {
      promptTemplate: 'Describe what you plan to commit and why, in 2-3 sentences.',
    }),
    node('status', 'tool.git.status', 'Inspect status'),
    node('diff', 'tool.git.diff', 'Inspect diff'),
    node('review', 'prompt.review', 'Self-review the diff', {
      promptTemplate:
        'Review the diff above. Respond with `{ "approved": boolean, "issues": string[] }`. Reject if anything looks risky.',
      outputSchema: { approved: 'boolean', issues: 'string[]' },
    }),
    node('gate', 'condition', 'Gate on approval', { condition: '$input.approved' }),
    node('commit', 'tool.git.commit', 'Commit', { message: '{{var.commitMessage}}' }),
    node('push', 'tool.git.push', 'Push'),
  ],
  connections: [
    edge('trigger', 'plan'),
    edge('plan', 'status'),
    edge('status', 'diff'),
    edge('diff', 'review'),
    edge('review', 'gate'),
    edge('gate', 'commit', 'true'),
    edge('commit', 'push'),
  ],
};

// ── 2. pr_triage ─────────────────────────────────────────────────────────────
const PR_TRIAGE: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.pr_triage@1',
  name: 'PR triage',
  description: 'Read the diff, rate risk + list issues, file a task for each issue.',
  subcategory: 'technical',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('diff', 'tool.git.diff', 'Read diff', { args: ['--stat', '-U3'] }),
    node('review', 'prompt.review', 'Score risk + list issues', {
      promptTemplate:
        'Review the diff. Respond with `{ "approved": boolean, "issues": string[], "riskScore": number }`. RiskScore is 0-10.',
      outputSchema: { approved: 'boolean', issues: 'string[]', riskScore: 'number' },
    }),
    node('file_task', 'sprint.create_task', 'File a task for follow-up', {
      subject: 'PR triage findings: {{var.riskScore}}/10',
      description: 'Issues: {{var.issues}}',
    }),
  ],
  connections: [edge('trigger', 'diff'), edge('diff', 'review'), edge('review', 'file_task')],
};

// ── 3. sprint_standup ────────────────────────────────────────────────────────
const SPRINT_STANDUP: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.sprint_standup@1',
  name: 'Sprint standup',
  description: 'Gather open tasks, synthesize a standup update, and file any follow-ups.',
  subcategory: 'pm',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('plan', 'prompt.plan', 'Outline the standup'),
    node('list', 'sprint.list_tasks', 'List open tasks'),
    node('synth', 'prompt.freeform', 'Write the standup update', {
      promptTemplate:
        'Using the task list above, write a concise standup update: "Done / In-progress / Blocked / Next". Then suggest up to 3 follow-up tasks.',
    }),
    node('file_followup', 'sprint.create_task', 'File one follow-up', {
      subject: 'Standup follow-up',
      description: '{{var.llmOutput}}',
    }),
  ],
  connections: [edge('trigger', 'plan'), edge('plan', 'list'), edge('list', 'synth'), edge('synth', 'file_followup')],
};

// ── 4. lead_qualify ──────────────────────────────────────────────────────────
const LEAD_QUALIFY: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.lead_qualify@1',
  name: 'Lead qualification',
  description: 'Extract qualifying fields from the incoming lead, then file a follow-up task for the owner.',
  subcategory: 'sales',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('extract', 'prompt.plan', 'Extract lead fields', {
      promptTemplate:
        'From the conversation, extract: name, company, titleSeniority, budgetSignal, timeline, intentScore (0-10). Respond as JSON.',
    }),
    node('file_task', 'sprint.create_task', 'File qualification task', {
      subject: 'Qualify lead: {{var.name}} @ {{var.company}}',
      description: 'Intent: {{var.intentScore}}/10 — {{var.llmOutput}}',
    }),
  ],
  connections: [edge('trigger', 'extract'), edge('extract', 'file_task')],
};

// ── 5. content_brief ─────────────────────────────────────────────────────────
const CONTENT_BRIEF: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.content_brief@1',
  name: 'Content brief',
  description: 'Plan → breakdown → draft → self-review. Produces a reviewable creative brief.',
  subcategory: 'marketing',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('plan', 'prompt.plan', 'Plan the brief'),
    node('break', 'prompt.create_todo', 'Break into sections', {
      promptTemplate:
        'Break the brief into an array of sections. Respond with `[{ "title": string, "ownerHint"?: string }, ...]`.',
    }),
    node('draft', 'prompt.freeform', 'Draft each section', {
      promptTemplate: 'Draft each section from the prior todo list in full prose. Keep each section under 200 words.',
    }),
    node('review', 'prompt.review', 'Self-review the brief', {
      promptTemplate: 'Review the draft. Respond with `{ "approved": boolean, "issues": string[] }`.',
      outputSchema: { approved: 'boolean', issues: 'string[]' },
    }),
  ],
  connections: [edge('trigger', 'plan'), edge('plan', 'break'), edge('break', 'draft'), edge('draft', 'review')],
};

// ── 6. research_digest ───────────────────────────────────────────────────────
const RESEARCH_DIGEST: BuiltinWorkflow = {
  canonicalId: 'builtin:workflow.research_digest@1',
  name: 'Research digest',
  description: 'Plan → break into topics → write a digest per topic.',
  subcategory: 'research',
  nodes: [
    node('trigger', 'trigger', 'Start'),
    node('plan', 'prompt.plan', 'Plan the digest'),
    node('break', 'prompt.create_todo', 'Break into topics', {
      promptTemplate: 'Break the research scope into topics. Respond with `[{ "title": string }, ...]`.',
    }),
    node('write', 'prompt.freeform', 'Write each topic', {
      promptTemplate: 'Write a 100-200 word digest for each topic in the prior list. Cite sources inline.',
    }),
  ],
  connections: [edge('trigger', 'plan'), edge('plan', 'break'), edge('break', 'write')],
};

const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  SAFE_COMMIT,
  PR_TRIAGE,
  SPRINT_STANDUP,
  LEAD_QUALIFY,
  CONTENT_BRIEF,
  RESEARCH_DIGEST,
];

/**
 * Seed built-in agent workflows. Idempotent — matches by
 * `canonical_id`, skips if the row already exists at or above the
 * current seed version. Called once at app boot from
 * `initStorage.ts`.
 *
 * @returns the number of rows inserted (0 on a warm reboot).
 */
export function seedBuiltinWorkflows(db: ISqliteDriver, userId: string): number {
  let seeded = 0;
  const now = Date.now();

  for (const wf of BUILTIN_WORKFLOWS) {
    const existing = db
      .prepare("SELECT id, managed_by_version FROM workflow_definitions WHERE canonical_id = ? AND source = 'builtin'")
      .get(wf.canonicalId) as { id: string; managed_by_version: number | null } | undefined;

    if (!existing) {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO workflow_definitions
           (id, user_id, name, description, nodes, connections, settings,
            enabled, version, created_at, updated_at,
            canonical_id, source, category, managed_by_version, published_to_fleet)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'builtin', ?, ?, 0)`
      ).run(
        id,
        userId,
        wf.name,
        wf.description,
        JSON.stringify(wf.nodes),
        JSON.stringify(wf.connections),
        JSON.stringify({}),
        now,
        now,
        wf.canonicalId,
        `agent-behavior/${wf.subcategory}`,
        WORKFLOW_SEED_VERSION
      );
      seeded += 1;
      continue;
    }

    // Upgrade in place if the shipped version is newer than what's
    // stored. Preserves user-facing id so existing bindings don't
    // break across an upgrade.
    const stored = existing.managed_by_version ?? 0;
    if (WORKFLOW_SEED_VERSION > stored) {
      db.prepare(
        `UPDATE workflow_definitions
         SET name = ?, description = ?, nodes = ?, connections = ?, updated_at = ?,
             category = ?, managed_by_version = ?
         WHERE id = ?`
      ).run(
        wf.name,
        wf.description,
        JSON.stringify(wf.nodes),
        JSON.stringify(wf.connections),
        now,
        `agent-behavior/${wf.subcategory}`,
        WORKFLOW_SEED_VERSION,
        existing.id
      );
      seeded += 1;
    }
  }

  if (seeded > 0) {
    logActivity(db, {
      userId,
      actorType: 'system',
      actorId: 'agent_workflows',
      action: 'workflow.builtins_seeded',
      entityType: 'workflow_definition',
      details: { seededCount: seeded, version: WORKFLOW_SEED_VERSION },
    });
  }

  return seeded;
}

/**
 * Test hook: read-only access to the seed list so tests can assert
 * what ships without re-implementing the constant. Not intended for
 * production callers.
 */
export function _listBuiltinWorkflows(): BuiltinWorkflow[] {
  return BUILTIN_WORKFLOWS;
}
