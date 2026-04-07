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
}
