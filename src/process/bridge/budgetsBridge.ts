/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX budget management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as budgetService from '@process/services/budgets';

export function initBudgetsBridge(): void {
  ipcBridge.budgets.listPolicies.provider(async ({ userId }) => {
    const db = await getDatabase();
    return budgetService.listPolicies(db.getDriver(), userId);
  });

  ipcBridge.budgets.upsertPolicy.provider(async (input) => {
    const db = await getDatabase();
    return budgetService.upsertPolicy(db.getDriver(), input);
  });

  ipcBridge.budgets.listIncidents.provider(async ({ userId, status }) => {
    const db = await getDatabase();
    return budgetService.listIncidents(db.getDriver(), userId, status);
  });

  ipcBridge.budgets.resolveIncident.provider(async ({ incidentId, status }) => {
    const db = await getDatabase();
    budgetService.resolveIncident(db.getDriver(), incidentId, status as 'resolved' | 'dismissed');
  });
}
