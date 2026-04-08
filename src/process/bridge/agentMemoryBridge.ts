/**
 * @license Apache-2.0
 * Agent memory bridge — IPC handlers for agent memory management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as memoryService from '@process/services/agentMemory';

export function initAgentMemoryBridge(): void {
  ipcBridge.agentMemory.list.provider(async ({ agentSlotId, memoryType }) => {
    const db = await getDatabase();
    return memoryService.listMemories(db.getDriver(), agentSlotId, memoryType);
  });

  ipcBridge.agentMemory.retrieve.provider(async ({ agentSlotId, limit }) => {
    const db = await getDatabase();
    return memoryService.retrieveRelevant(db.getDriver(), agentSlotId, limit);
  });

  ipcBridge.agentMemory.clear.provider(async ({ agentSlotId, memoryType }) => {
    const db = await getDatabase();
    return memoryService.clearMemory(db.getDriver(), agentSlotId, memoryType);
  });

  ipcBridge.agentMemory.stats.provider(async ({ agentSlotId }) => {
    const db = await getDatabase();
    return memoryService.getMemoryStats(db.getDriver(), agentSlotId);
  });
}
