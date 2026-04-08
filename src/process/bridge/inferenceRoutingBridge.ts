/**
 * @license Apache-2.0
 * Inference routing bridge — IPC handlers for managed inference routing.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as inferenceService from '@process/services/inferenceGateway';

export function initInferenceRoutingBridge(): void {
  ipcBridge.inferenceRouting.list.provider(async ({ agentGalleryId }) => {
    const db = await getDatabase();
    return inferenceService.listRoutes(db.getDriver(), agentGalleryId);
  });

  ipcBridge.inferenceRouting.create.provider(async (input) => {
    const db = await getDatabase();
    return inferenceService.createRoute(db.getDriver(), input);
  });

  ipcBridge.inferenceRouting.remove.provider(async ({ routeId }) => {
    const db = await getDatabase();
    return inferenceService.deleteRoute(db.getDriver(), routeId);
  });
}
