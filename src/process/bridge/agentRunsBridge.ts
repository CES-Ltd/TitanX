/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX agent run tracking.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as agentRunsService from '@process/services/agentRuns';

export function initAgentRunsBridge(): void {
  ipcBridge.agentRuns.list.provider(async (params) => {
    const db = await getDatabase();
    return agentRunsService.listRuns(db.getDriver(), params);
  });

  ipcBridge.agentRuns.stats.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return agentRunsService.getRunStats(db.getDriver(), userId, fromDate);
  });
}
