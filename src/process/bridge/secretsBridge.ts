/**
 * @license Apache-2.0
 * IPC bridge handlers for TitanX secrets management.
 */

import { ipcBridge } from '@/common';
import { getDatabase } from '@process/services/database';
import * as secretsService from '@process/services/secrets';
import * as activityLogService from '@process/services/activityLog';

export function initSecretsBridge(): void {
  ipcBridge.secrets.list.provider(async ({ userId }) => {
    const db = await getDatabase();
    return secretsService.listSecrets(db.getDriver(), userId);
  });

  ipcBridge.secrets.create.provider(async ({ userId, name, value }) => {
    const db = await getDatabase();
    const driver = db.getDriver();
    const secret = secretsService.createSecret(driver, { userId, name, value });

    activityLogService.logActivity(driver, {
      userId,
      actorType: 'user',
      actorId: userId,
      action: 'secret.created',
      entityType: 'secret',
      entityId: secret.id,
      details: { name },
    });
    ipcBridge.liveEvents.activity.emit({
      id: '',
      userId,
      actorType: 'user',
      actorId: userId,
      action: 'secret.created',
      entityType: 'secret',
      entityId: secret.id,
      details: { name },
      createdAt: Date.now(),
    });

    return secret;
  });

  ipcBridge.secrets.rotate.provider(async ({ secretId, value }) => {
    const db = await getDatabase();
    return secretsService.rotateSecret(db.getDriver(), { secretId, value });
  });

  ipcBridge.secrets.remove.provider(async ({ secretId }) => {
    const db = await getDatabase();
    return secretsService.deleteSecret(db.getDriver(), secretId);
  });

  ipcBridge.secrets.resolve.provider(async ({ secretId, version }) => {
    const db = await getDatabase();
    return secretsService.resolveSecretValue(db.getDriver(), secretId, version);
  });
}
