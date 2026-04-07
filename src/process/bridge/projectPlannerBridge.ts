/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX Project Planner.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as plannerService from '@process/services/projectPlanner';

export function initProjectPlannerBridge(): void {
  ipcBridge.projectPlanner.list.provider(async (params) => {
    const db = await getDatabase();
    return plannerService.listPlans(db.getDriver(), params);
  });

  ipcBridge.projectPlanner.get.provider(async ({ planId }) => {
    const db = await getDatabase();
    return plannerService.getPlan(db.getDriver(), planId);
  });

  ipcBridge.projectPlanner.create.provider(async (input) => {
    const db = await getDatabase();
    return plannerService.createPlan(db.getDriver(), input);
  });

  ipcBridge.projectPlanner.update.provider(async ({ planId, updates }) => {
    const db = await getDatabase();
    plannerService.updatePlan(db.getDriver(), planId, updates);
  });

  ipcBridge.projectPlanner.remove.provider(async ({ planId }) => {
    const db = await getDatabase();
    return plannerService.deletePlan(db.getDriver(), planId);
  });
}
