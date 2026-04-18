/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX IAM policies.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as iamService from '@process/services/iamPolicies';
import { assertNotManaged } from '@process/services/fleetConfig';

export function initIAMBridge(): void {
  ipcBridge.iamPolicies.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    return iamService.listPolicies(db.getDriver(), userId);
  });

  ipcBridge.iamPolicies.create.provider(async (input) => {
    const db = await getDatabase();
    // Creates are always allowed — the new row gets source='local' and
    // is NOT added to managed_config_keys, so master's next bundle leaves
    // it alone. Users can author + evolve local policies on a slave even
    // while master-pushed policies are locked.
    return iamService.createPolicy(db.getDriver(), input);
  });

  ipcBridge.iamPolicies.remove.provider(async ({ policyId }) => {
    const db = await getDatabase();
    // Block deletion of master-managed policies. Without this guard, the
    // row would come back on the next poll (applyConfigBundle re-inserts
    // everything in the bundle) — rejecting up-front gives clearer UX.
    assertNotManaged(db.getDriver(), `iam.policy.${policyId}`);
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
