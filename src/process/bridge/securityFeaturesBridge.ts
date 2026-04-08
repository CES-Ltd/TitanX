/**
 * @license Apache-2.0
 * Security features bridge — IPC handlers for master feature toggles.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as securityService from '@process/services/securityFeatures';
import type { SecurityFeature } from '@process/services/securityFeatures';

export function initSecurityFeaturesBridge(): void {
  ipcBridge.securityFeatures.list.provider(async () => {
    const db = await getDatabase();
    return securityService.listToggles(db.getDriver());
  });

  ipcBridge.securityFeatures.toggle.provider(async ({ feature, enabled }) => {
    const db = await getDatabase();
    securityService.setToggle(db.getDriver(), feature as SecurityFeature, enabled);
  });
}
