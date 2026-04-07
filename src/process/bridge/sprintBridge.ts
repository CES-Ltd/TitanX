/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX Agent Sprint board.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';

export function initSprintBridge(): void {
  ipcBridge.sprintBoard.list.provider(async ({ teamId }) => {
    const db = await getDatabase();
    return sprintService.listTasks(db.getDriver(), teamId);
  });

  ipcBridge.sprintBoard.get.provider(async ({ taskId }) => {
    const db = await getDatabase();
    return sprintService.getTask(db.getDriver(), taskId);
  });

  ipcBridge.sprintBoard.create.provider(async (input) => {
    const db = await getDatabase();
    return sprintService.createTask(db.getDriver(), input);
  });

  ipcBridge.sprintBoard.update.provider(async ({ taskId, updates }) => {
    const db = await getDatabase();
    sprintService.updateTask(db.getDriver(), taskId, updates);
  });

  ipcBridge.sprintBoard.remove.provider(async ({ taskId }) => {
    const db = await getDatabase();
    return sprintService.deleteTask(db.getDriver(), taskId);
  });

  ipcBridge.sprintBoard.addComment.provider(async ({ taskId, author, authorType, content }) => {
    const db = await getDatabase();
    return sprintService.addComment(db.getDriver(), taskId, author, authorType, content);
  });
}
