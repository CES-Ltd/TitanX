/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX Agent Gallery.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as galleryService from '@process/services/agentGallery';

export function initAgentGalleryBridge(): void {
  ipcBridge.agentGallery.list.provider(async ({ userId, whitelistedOnly }) => {
    const db = await getDatabase();
    return galleryService.listAgents(db.getDriver(), userId, whitelistedOnly);
  });

  ipcBridge.agentGallery.get.provider(async ({ agentId }) => {
    const db = await getDatabase();
    return galleryService.getAgent(db.getDriver(), agentId);
  });

  ipcBridge.agentGallery.create.provider(async (input) => {
    const db = await getDatabase();
    return galleryService.createAgent(db.getDriver(), input);
  });

  ipcBridge.agentGallery.update.provider(async ({ agentId, updates }) => {
    const db = await getDatabase();
    galleryService.updateAgent(db.getDriver(), agentId, updates);
  });

  ipcBridge.agentGallery.remove.provider(async ({ agentId }) => {
    const db = await getDatabase();
    return galleryService.deleteAgent(db.getDriver(), agentId);
  });

  ipcBridge.agentGallery.checkName.provider(async ({ userId, name }) => {
    const db = await getDatabase();
    const available = galleryService.isNameAvailable(db.getDriver(), userId, name);
    return { available };
  });
}
