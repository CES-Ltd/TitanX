/**
 * @license Apache-2.0
 * Agent Workflow Builder — workflow_bindings CRUD.
 *
 * A binding links a `workflow_definitions` row to either:
 *   - an `agent_gallery` template (template-level default — applies
 *     to every hire of that template unless superseded), or
 *   - a specific `team_agents.slot_id` (slot-level override set at
 *     hire time — supersedes the template default for that hire).
 *
 * Shape + audit-log behavior mirror `iam_policy_bindings` /
 * PolicyBinding (src/process/services/iamPolicies/index.ts:153). Same
 * `expires_at` TTL semantics: a binding is excluded from list/resolve
 * output once its expiry timestamp is in the past, but the row stays
 * in the table for audit-trail visibility.
 *
 * Activity-log actions emitted:
 *   - `workflow.binding_created` on createBinding
 *   - `workflow.binding_deleted` on deleteBinding
 *
 * Unlike IAM, we intentionally do NOT call bumpConfigVersion here.
 * The fleet-config-version gate is an IAM-specific concern for
 * master/slave policy distribution; workflow distribution will get
 * its own versioning hook in Phase 3 (see plan.md § Fork-on-edit).
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import type { CreateWorkflowBindingInput, WorkflowBinding } from './agent-types';

/**
 * Create a new binding. Throws if neither scope is set — the migration
 * v74 CHECK constraint would catch this at the DB layer, but we
 * surface a typed error earlier so callers get a clean message.
 */
export function createBinding(db: ISqliteDriver, input: CreateWorkflowBindingInput): WorkflowBinding {
  if (!input.agentGalleryId && !input.slotId) {
    throw new Error('createBinding: one of agentGalleryId or slotId is required');
  }

  const id = crypto.randomUUID();
  const boundAt = Date.now();

  db.prepare(
    `INSERT INTO workflow_bindings (id, workflow_definition_id, agent_gallery_id, slot_id, team_id, bound_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.workflowDefinitionId,
    input.agentGalleryId ?? null,
    input.slotId ?? null,
    input.teamId ?? null,
    boundAt,
    input.expiresAt ?? null
  );

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'agent_workflows',
    action: 'workflow.binding_created',
    entityType: 'workflow_binding',
    entityId: id,
    details: {
      workflowDefinitionId: input.workflowDefinitionId,
      agentGalleryId: input.agentGalleryId,
      slotId: input.slotId,
      teamId: input.teamId,
      expiresAt: input.expiresAt,
    },
  });

  return {
    id,
    workflowDefinitionId: input.workflowDefinitionId,
    agentGalleryId: input.agentGalleryId,
    slotId: input.slotId,
    teamId: input.teamId,
    boundAt,
    expiresAt: input.expiresAt,
  };
}

export function getBinding(db: ISqliteDriver, bindingId: string): WorkflowBinding | null {
  const row = db.prepare('SELECT * FROM workflow_bindings WHERE id = ?').get(bindingId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToBinding(row) : null;
}

export function deleteBinding(db: ISqliteDriver, bindingId: string): boolean {
  const deleted = db.prepare('DELETE FROM workflow_bindings WHERE id = ?').run(bindingId).changes > 0;
  if (deleted) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'agent_workflows',
      action: 'workflow.binding_deleted',
      entityType: 'workflow_binding',
      entityId: bindingId,
    });
  }
  return deleted;
}

export function listBindingsByTemplate(db: ISqliteDriver, agentGalleryId: string): WorkflowBinding[] {
  const rows = db
    .prepare('SELECT * FROM workflow_bindings WHERE agent_gallery_id = ? ORDER BY bound_at DESC')
    .all(agentGalleryId) as Array<Record<string, unknown>>;
  return filterUnexpired(rows).map(rowToBinding);
}

export function listBindingsBySlot(db: ISqliteDriver, slotId: string): WorkflowBinding[] {
  const rows = db
    .prepare('SELECT * FROM workflow_bindings WHERE slot_id = ? ORDER BY bound_at DESC')
    .all(slotId) as Array<Record<string, unknown>>;
  return filterUnexpired(rows).map(rowToBinding);
}

export function listBindingsByTeam(db: ISqliteDriver, teamId: string): WorkflowBinding[] {
  const rows = db
    .prepare('SELECT * FROM workflow_bindings WHERE team_id = ? ORDER BY bound_at DESC')
    .all(teamId) as Array<Record<string, unknown>>;
  return filterUnexpired(rows).map(rowToBinding);
}

/**
 * Resolve the effective binding for a hired agent. Slot-level binding
 * takes precedence over template-level for the same slot — this is
 * the one call site the dispatcher hits on every turn, so it stays
 * simple: slot first, template fallback, null if neither is bound.
 *
 * Returning null is the zero-impact backward-compat path — callers
 * that see null should skip all workflow-context injection and run
 * the agent exactly as pre-v74 (no suspend/resume, no step evaluation,
 * no new audit entries). This preserves every behavioral guarantee of
 * the pre-v2.6.0 agent turn loop.
 */
export function resolveActiveBinding(
  db: ISqliteDriver,
  scope: { slotId: string; agentGalleryId?: string }
): WorkflowBinding | null {
  const slotBindings = listBindingsBySlot(db, scope.slotId);
  if (slotBindings.length > 0) return slotBindings[0];
  if (scope.agentGalleryId) {
    const templateBindings = listBindingsByTemplate(db, scope.agentGalleryId);
    if (templateBindings.length > 0) return templateBindings[0];
  }
  return null;
}

function filterUnexpired(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const now = Date.now();
  return rows.filter((r) => {
    const expiresAt = (r.expires_at as number | null) ?? undefined;
    return !expiresAt || expiresAt > now;
  });
}

function rowToBinding(row: Record<string, unknown>): WorkflowBinding {
  return {
    id: row.id as string,
    workflowDefinitionId: row.workflow_definition_id as string,
    agentGalleryId: (row.agent_gallery_id as string | null) ?? undefined,
    slotId: (row.slot_id as string | null) ?? undefined,
    teamId: (row.team_id as string | null) ?? undefined,
    boundAt: row.bound_at as number,
    expiresAt: (row.expires_at as number | null) ?? undefined,
  };
}
