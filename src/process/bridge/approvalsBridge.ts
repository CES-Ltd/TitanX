/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX approval workflows.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as approvalsService from '@process/services/approvals';
import * as activityLogService from '@process/services/activityLog';

export function initApprovalsBridge(): void {
  ipcBridge.approvals.list.provider(async ({ userId, status }) => {
    const db = await getDatabase();
    return approvalsService.listApprovals(db.getDriver(), userId, status);
  });

  ipcBridge.approvals.decide.provider(async ({ approvalId, status, note }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    approvalsService.decideApproval(driver, {
      approvalId,
      status: status as 'approved' | 'rejected',
      decisionNote: note,
    });

    // Log approval decision to activity trail
    activityLogService.logActivity(driver, {
      userId: '', // Will be filled by caller context
      actorType: 'user',
      actorId: 'board',
      action: `approval.${status}`,
      entityType: 'approval',
      entityId: approvalId,
      details: { status, note },
    });
  });

  ipcBridge.approvals.pendingCount.provider(async ({ userId }) => {
    const db = await getDatabase();
    return approvalsService.getPendingCount(db.getDriver(), userId);
  });
}
