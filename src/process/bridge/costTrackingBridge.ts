/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX cost tracking.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as costTrackingService from '@process/services/costTracking';
import * as budgetService from '@process/services/budgets';

export function initCostTrackingBridge(): void {
  ipcBridge.costTracking.record.provider(async (input) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    costTrackingService.recordCost(driver, input);

    // Enforce budgets after recording cost
    budgetService.enforceBudgets(driver, input.userId);

    // Emit live event
    ipcBridge.liveEvents.cost.emit(input);
  });

  ipcBridge.costTracking.summary.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return costTrackingService.getCostSummary(db.getDriver(), userId, fromDate);
  });

  ipcBridge.costTracking.byAgent.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return costTrackingService.getCostByAgent(db.getDriver(), userId, fromDate);
  });

  ipcBridge.costTracking.byProvider.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return costTrackingService.getCostByProvider(db.getDriver(), userId, fromDate);
  });

  ipcBridge.costTracking.windowSpend.provider(async ({ userId }) => {
    const db = await getDatabase();
    return costTrackingService.getWindowSpend(db.getDriver(), userId);
  });
}
