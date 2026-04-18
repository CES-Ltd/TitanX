/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX activity log.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as activityLogService from '@process/services/activityLog';

export function initActivityLogBridge(): void {
  ipcBridge.activityLog.list.provider(async (params) => {
    const db = await getDatabase();
    return activityLogService.listActivities(db.getDriver(), params);
  });

  ipcBridge.activityLog.forEntity.provider(async ({ entityType, entityId }) => {
    const db = await getDatabase();
    return activityLogService.getActivitiesForEntity(db.getDriver(), entityType, entityId);
  });

  // v1.9.39 — dynamic filter dropdowns feed
  ipcBridge.activityLog.distinctActions.provider(async ({ userId }) => {
    const db = await getDatabase();
    return activityLogService.getDistinctActions(db.getDriver(), userId);
  });

  ipcBridge.activityLog.distinctEntityTypes.provider(async ({ userId }) => {
    const db = await getDatabase();
    return activityLogService.getDistinctEntityTypes(db.getDriver(), userId);
  });
}
