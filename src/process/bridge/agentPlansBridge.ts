/**
 * @license Apache-2.0
 * Agent plans bridge — IPC handlers for agent planning management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as planningService from '@process/services/agentPlanning';

export function initAgentPlansBridge(): void {
  ipcBridge.agentPlans.list.provider(async ({ teamId, agentSlotId, status }) => {
    const db = await getDatabase();
    return planningService.listPlans(db.getDriver(), teamId, agentSlotId, status);
  });

  ipcBridge.agentPlans.get.provider(async ({ planId }) => {
    const db = await getDatabase();
    return planningService.getPlan(db.getDriver(), planId);
  });

  ipcBridge.agentPlans.active.provider(async ({ agentSlotId }) => {
    const db = await getDatabase();
    return planningService.getActivePlan(db.getDriver(), agentSlotId);
  });

  // Sync plans from existing team_tasks on startup (idempotent backfill)
  void (async () => {
    try {
      const db = await getDatabase();
      planningService.syncPlansFromTasks(db.getDriver());
    } catch {
      // Non-critical startup task
    }
  })();
}
