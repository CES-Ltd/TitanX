/**
 * IPC bridge handlers for Caveman Mode — token saving.
 */

import { ipcBridge } from '@/common';
import { ProcessConfig } from '@process/utils/initStorage';
import { getDatabase } from '@process/services/database';
import * as savingsTracker from '@process/services/caveman/savingsTracker';
import * as activityLog from '@process/services/activityLog';
import type { CavemanMode } from '@process/services/caveman';

export function initCavemanBridge(): void {
  ipcBridge.caveman.getMode.provider(async () => {
    const mode = ((await ProcessConfig.get('system.cavemanMode')) as string) || 'off';
    console.log(`[CavemanBridge] getMode: ${mode}`);
    return { mode };
  });

  ipcBridge.caveman.setMode.provider(async ({ mode }) => {
    const previousMode = ((await ProcessConfig.get('system.cavemanMode')) as string) || 'off';
    await ProcessConfig.set('system.cavemanMode', mode);
    console.log(`[CavemanBridge] setMode: ${previousMode} → ${mode}`);

    // Audit log the change
    try {
      const db = await getDatabase();
      activityLog.logActivity(db.getDriver(), {
        userId: 'system_default_user',
        actorType: 'user',
        actorId: 'system_default_user',
        action: 'caveman.mode_changed',
        entityType: 'setting',
        entityId: 'caveman.mode',
        details: { previousMode, newMode: mode, timestamp: Date.now() },
      });
    } catch (err) {
      console.warn('[CavemanBridge] Failed to audit log mode change:', err);
    }
  });

  ipcBridge.caveman.getSummary.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return savingsTracker.getSummary(db.getDriver(), userId, fromDate);
  });

  ipcBridge.caveman.getByMode.provider(async ({ userId, fromDate }) => {
    const db = await getDatabase();
    return savingsTracker.getByMode(db.getDriver(), userId, fromDate);
  });
}

/**
 * Get the current caveman mode from config (sync-safe for use in agent managers).
 */
export async function getCurrentCavemanMode(): Promise<CavemanMode> {
  const mode = ((await ProcessConfig.get('system.cavemanMode')) as string) || 'off';
  return mode as CavemanMode;
}
