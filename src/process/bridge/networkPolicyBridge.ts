/**
 * @license Apache-2.0
 * Network policy bridge — IPC handlers for network egress policy management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as networkPolicyService from '@process/services/networkPolicy';
import { listPresetNames } from '@process/services/networkPolicy/presets';

export function initNetworkPolicyBridge(): void {
  ipcBridge.networkPolicies.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    return networkPolicyService.listPolicies(db.getDriver(), userId);
  });

  ipcBridge.networkPolicies.create.provider(async (input) => {
    const db = await getDatabase();
    return networkPolicyService.createPolicy(db.getDriver(), {
      userId: input.userId,
      name: input.name,
      agentGalleryId: input.agentGalleryId,
      rules: input.rules as Parameters<typeof networkPolicyService.createPolicy>[1]['rules'],
    });
  });

  ipcBridge.networkPolicies.remove.provider(async ({ policyId }) => {
    const db = await getDatabase();
    return networkPolicyService.deletePolicy(db.getDriver(), policyId);
  });

  ipcBridge.networkPolicies.toggle.provider(async ({ policyId, enabled }) => {
    const db = await getDatabase();
    networkPolicyService.togglePolicy(db.getDriver(), policyId, enabled);
  });

  ipcBridge.networkPolicies.applyPreset.provider(async ({ userId, preset, agentGalleryId }) => {
    const db = await getDatabase();
    return networkPolicyService.applyPreset(db.getDriver(), userId, preset, agentGalleryId);
  });

  ipcBridge.networkPolicies.listPresets.provider(async () => {
    return listPresetNames();
  });
}
