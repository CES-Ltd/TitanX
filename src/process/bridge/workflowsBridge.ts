/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX workflow rules.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as workflowService from '@process/services/workflows';

export function initWorkflowsBridge(): void {
  ipcBridge.workflowRules.list.provider(async ({ userId, type }) => {
    const db = await getDatabase();
    return workflowService.listRules(db.getDriver(), userId, type as workflowService.WorkflowType | undefined);
  });

  ipcBridge.workflowRules.create.provider(async (input) => {
    const db = await getDatabase();
    return workflowService.createRule(db.getDriver(), {
      ...input,
      type: input.type as workflowService.WorkflowType,
    });
  });

  ipcBridge.workflowRules.update.provider(async ({ ruleId, updates }) => {
    const db = await getDatabase();
    workflowService.updateRule(db.getDriver(), ruleId, updates);
  });

  ipcBridge.workflowRules.remove.provider(async ({ ruleId }) => {
    const db = await getDatabase();
    return workflowService.deleteRule(db.getDriver(), ruleId);
  });
}
