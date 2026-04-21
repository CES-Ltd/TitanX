/**
 * @license Apache-2.0
 * Agent Workflow Builder — fleet publish / unpublish (v2.6.0 Phase 3).
 *
 * Mirrors the `agentGallery.publishToFleet` pattern:
 *   - UPDATE workflow_definitions SET published_to_fleet = 1 WHERE id = ?
 *   - Fire-and-forget bumpConfigVersion so slaves pick up the change
 *     on their next 30s poll.
 *   - Idempotent: re-publishing an already-published row still bumps
 *     (the admin action is audit-worthy) but produces no visible
 *     slave change since bundle content is unchanged.
 *
 * Safety filter — callers should not publish `source='master'` rows;
 * those arrived from an upstream master and re-broadcasting them
 * would create a loop. `buildConfigBundle` filters them out, but we
 * also reject at this layer so the audit trail is clean.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { bumpConfigVersion } from '../fleetConfig';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';

export function publishWorkflowToFleet(
  db: ISqliteDriver,
  workflowId: string,
  updatedBy: string = 'system_default_user'
): boolean {
  const row = db.prepare('SELECT id, source FROM workflow_definitions WHERE id = ?').get(workflowId) as
    | { id: string; source: string | null }
    | undefined;
  if (!row) return false;
  if (row.source === 'master') {
    // Refuse to re-broadcast a master-sourced row; that's how loops form.
    return false;
  }

  const result = db
    .prepare('UPDATE workflow_definitions SET published_to_fleet = 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), workflowId);
  if (result.changes === 0) return false;

  logActivity(db, {
    userId: updatedBy,
    actorType: 'user',
    actorId: updatedBy,
    action: 'workflow.published',
    entityType: 'workflow_definition',
    entityId: workflowId,
  });

  try {
    bumpConfigVersion(db, { reason: 'workflow.published', updatedBy, entityId: workflowId });
  } catch (e) {
    logNonCritical('fleet.config.bump.workflow_published', e);
  }
  return true;
}

export function unpublishWorkflowFromFleet(
  db: ISqliteDriver,
  workflowId: string,
  updatedBy: string = 'system_default_user'
): boolean {
  const result = db
    .prepare('UPDATE workflow_definitions SET published_to_fleet = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), workflowId);
  if (result.changes === 0) return false;

  logActivity(db, {
    userId: updatedBy,
    actorType: 'user',
    actorId: updatedBy,
    action: 'workflow.unpublished',
    entityType: 'workflow_definition',
    entityId: workflowId,
  });

  try {
    bumpConfigVersion(db, { reason: 'workflow.unpublished', updatedBy, entityId: workflowId });
  } catch (e) {
    logNonCritical('fleet.config.bump.workflow_unpublished', e);
  }
  return true;
}
