/**
 * @license Apache-2.0
 * Blueprint bridge — IPC handlers for agent blueprint/profile management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as blueprintService from '@process/services/blueprints';

export function initBlueprintBridge(): void {
  ipcBridge.blueprints.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    return blueprintService.listBlueprints(db.getDriver(), userId);
  });

  ipcBridge.blueprints.get.provider(async ({ blueprintId }) => {
    const db = await getDatabase();
    return blueprintService.getBlueprint(db.getDriver(), blueprintId);
  });

  ipcBridge.blueprints.create.provider(async (input) => {
    const db = await getDatabase();
    return blueprintService.createBlueprint(db.getDriver(), {
      userId: input.userId,
      name: input.name,
      description: input.description,
      config: input.config as blueprintService.BlueprintConfig,
    });
  });

  ipcBridge.blueprints.remove.provider(async ({ blueprintId }) => {
    const db = await getDatabase();
    return blueprintService.deleteBlueprint(db.getDriver(), blueprintId);
  });

  ipcBridge.blueprints.seed.provider(async ({ userId }) => {
    const db = await getDatabase();
    return blueprintService.seedBuiltinBlueprints(db.getDriver(), userId);
  });

  ipcBridge.blueprints.toggle.provider(async ({ blueprintId, enabled }) => {
    const db = await getDatabase();
    blueprintService.toggleBlueprint(db.getDriver(), blueprintId, enabled);
  });
}
