/**
 * @license Apache-2.0
 * Deep Agent bridge — IPC handlers for research orchestration.
 */

import { ipcBridge } from '@/common';
import type { IConversationService } from '@process/services/IConversationService';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import * as deepAgentService from '@process/services/deepAgent';

export function initDeepAgentBridge(
  conversationService: IConversationService,
  workerTaskManager: IWorkerTaskManager
): void {
  // Inject dependencies into the service layer
  deepAgentService.setDependencies(conversationService, workerTaskManager);

  ipcBridge.deepAgent.startSession.provider(async (params) => {
    return deepAgentService.startSession(params);
  });

  ipcBridge.deepAgent.sendMessage.provider(async (params) => {
    return deepAgentService.sendMessage(params);
  });

  ipcBridge.deepAgent.getSession.provider(async ({ sessionId }) => {
    return deepAgentService.getSession(sessionId) ?? null;
  });

  ipcBridge.deepAgent.stopSession.provider(async ({ sessionId }) => {
    await deepAgentService.stopSession(sessionId);
  });
}
