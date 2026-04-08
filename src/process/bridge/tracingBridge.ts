/**
 * @license Apache-2.0
 * Tracing bridge — IPC handlers for LangSmith-compatible trace system.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as tracingService from '@process/services/tracing';

export function initTracingBridge(): void {
  ipcBridge.traceSystem.listRuns.provider(async (filters) => {
    const db = await getDatabase();
    return tracingService.listRuns(db.getDriver(), filters);
  });

  ipcBridge.traceSystem.getTraceTree.provider(async ({ rootRunId }) => {
    const db = await getDatabase();
    return tracingService.getTraceTree(db.getDriver(), rootRunId);
  });

  ipcBridge.traceSystem.getRun.provider(async ({ runId }) => {
    const db = await getDatabase();
    return tracingService.getRun(db.getDriver(), runId);
  });

  ipcBridge.traceSystem.addFeedback.provider(async ({ runId, score, value, comment }) => {
    const db = await getDatabase();
    return tracingService.addFeedback(db.getDriver(), runId, 'system_default_user', score, value, comment);
  });

  ipcBridge.traceSystem.listFeedback.provider(async ({ runId }) => {
    const db = await getDatabase();
    return tracingService.listFeedback(db.getDriver(), runId);
  });
}
