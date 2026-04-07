/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX credential access control.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as credentialAccessService from '@process/services/credentialAccess';

export function initCredentialAccessBridge(): void {
  ipcBridge.credentialAccess.check.provider(async ({ agentGalleryId, secretId }) => {
    const db = await getDatabase();
    return credentialAccessService.checkCredentialAccess(db.getDriver(), agentGalleryId, secretId);
  });

  ipcBridge.credentialAccess.issue.provider(async ({ agentGalleryId, policyId, secretId }) => {
    const db = await getDatabase();
    return credentialAccessService.issueAccessToken(db.getDriver(), agentGalleryId, policyId, secretId);
  });

  ipcBridge.credentialAccess.resolve.provider(async ({ token, secretId }) => {
    const db = await getDatabase();
    return credentialAccessService.resolveWithToken(db.getDriver(), token, secretId, 'system_default_user');
  });

  ipcBridge.credentialAccess.revokeExpired.provider(async () => {
    const db = await getDatabase();
    return credentialAccessService.revokeExpiredTokens(db.getDriver());
  });
}
