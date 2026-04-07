/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX IAM policies.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as iamService from '@process/services/iamPolicies';

export function initIAMBridge(): void {
  ipcBridge.iamPolicies.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    return iamService.listPolicies(db.getDriver(), userId);
  });

  ipcBridge.iamPolicies.create.provider(async (input) => {
    const db = await getDatabase();
    return iamService.createPolicy(db.getDriver(), input);
  });

  ipcBridge.iamPolicies.remove.provider(async ({ policyId }) => {
    const db = await getDatabase();
    return iamService.deletePolicy(db.getDriver(), policyId);
  });

  ipcBridge.iamPolicies.bind.provider(async ({ agentGalleryId, policyId, ttlSeconds }) => {
    const db = await getDatabase();
    return iamService.bindPolicy(db.getDriver(), agentGalleryId, policyId, ttlSeconds);
  });

  ipcBridge.iamPolicies.listBindings.provider(async ({ agentGalleryId }) => {
    const db = await getDatabase();
    return iamService.listBindings(db.getDriver(), agentGalleryId);
  });

  ipcBridge.iamPolicies.unbind.provider(async ({ bindingId }) => {
    const db = await getDatabase();
    return iamService.unbindPolicy(db.getDriver(), bindingId);
  });
}
