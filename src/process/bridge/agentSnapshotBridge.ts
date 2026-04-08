/**
 * @license Apache-2.0
 * Agent snapshot bridge — IPC handlers for agent state capture/restore.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as snapshotService from '@process/services/agentSnapshot';
import * as activityLogService from '@process/services/activityLog';

export function initAgentSnapshotBridge(): void {
  ipcBridge.agentSnapshots.create.provider(async ({ agentGalleryId, teamId, note }) => {
    const db = await getDatabase();
    // createSnapshot already calls logActivity internally
    return snapshotService.createSnapshot(db.getDriver(), agentGalleryId, teamId, note);
  });

  ipcBridge.agentSnapshots.list.provider(async ({ agentGalleryId }) => {
    const db = await getDatabase();
    return snapshotService.listSnapshots(db.getDriver(), agentGalleryId);
  });

  ipcBridge.agentSnapshots.get.provider(async ({ snapshotId }) => {
    const db = await getDatabase();
    return snapshotService.getSnapshot(db.getDriver(), snapshotId);
  });

  ipcBridge.agentSnapshots.exportSanitized.provider(async ({ snapshotId }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    const snapshot = snapshotService.getSnapshot(driver, snapshotId);
    if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`);
    const sanitized = snapshotService.sanitizeSnapshotForExport(snapshot);

    activityLogService.logActivity(driver, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: 'system_default_user',
      action: 'agent_snapshot.exported',
      entityType: 'agent_snapshot',
      entityId: snapshotId,
      details: { agentGalleryId: snapshot.agentGalleryId },
    });

    return JSON.stringify(sanitized, null, 2);
  });
}
