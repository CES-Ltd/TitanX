/**
 * @license Apache-2.0
 * Fleet bridge — IPC providers for the v1.9.26+ master/slave mode system.
 *
 * Bridges renderer calls (setup wizard, Settings mode switcher, sidebar
 * mode-gating hook) into the `fleet` service. Also emits
 * `fleet:mode-changed` to force renderer SWR caches to refresh after
 * mode changes.
 *
 * The `fleet_mode_enabled` security feature flag is consulted at
 * getMode / isSetupRequired so customers can disable the whole
 * feature per-install. When disabled, `getMode()` always returns
 * 'regular' and `isSetupRequired()` always returns false, even if
 * a prior install wrote `fleet.mode = 'slave'` — this gives an
 * emergency kill switch if a rollout causes issues.
 */

import { ipcBridge } from '@/common';
import {
  applyFleetSetup,
  applyWizardCancelled,
  getFleetConfig,
  getFleetMode,
  isSetupRequired,
  validateFleetSetup,
} from '@process/services/fleet';
import { getDatabase } from '@process/services/database';
import * as securityFeaturesService from '@process/services/securityFeatures';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { FleetMode, FleetSetupInput, FleetSetupResult } from '@/common/types/fleetTypes';

const FEATURE_FLAG = 'fleet_mode_enabled';

/**
 * Check the feature flag. Returns `true` on failure so the default
 * install experience is to HAVE fleet mode (the feature is GA from
 * v1.9.26) — the flag only matters when an admin has explicitly
 * disabled it.
 */
async function isFleetModeFeatureEnabled(): Promise<boolean> {
  try {
    const db = await getDatabase();
    return securityFeaturesService.isFeatureEnabled(db.getDriver(), FEATURE_FLAG as never);
  } catch (e) {
    logNonCritical('fleet.featureFlag.check', e);
    return true;
  }
}

export function initFleetBridge(): void {
  ipcBridge.fleet.getMode.provider(async (): Promise<FleetMode> => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) return 'regular';
    return getFleetMode();
  });

  ipcBridge.fleet.getConfig.provider(async () => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) {
      return { mode: 'regular' as const };
    }
    return getFleetConfig();
  });

  ipcBridge.fleet.isSetupRequired.provider(async () => {
    const flag = await isFleetModeFeatureEnabled();
    if (!flag) return false;
    return isSetupRequired();
  });

  ipcBridge.fleet.completeSetup.provider(async (input: FleetSetupInput): Promise<FleetSetupResult> => {
    // Honor the "Cancel" action from the wizard (encoded as mode=regular
    // with no other fields). Writes regular + audit, skips setupCompletedAt.
    if (input.mode === 'regular' && input.masterPort == null && input.slaveMasterUrl == null) {
      await applyWizardCancelled();
      emitModeChanged('regular');
      return { ok: true };
    }

    const result = await applyFleetSetup(input);
    if (result.ok) emitModeChanged(input.mode);
    return result;
  });

  ipcBridge.fleet.setMode.provider(async (input: FleetSetupInput): Promise<FleetSetupResult> => {
    const validationError = validateFleetSetup(input);
    if (validationError) return { ok: false, error: validationError };

    const result = await applyFleetSetup(input);
    if (result.ok) emitModeChanged(input.mode);
    return result;
  });
}

function emitModeChanged(mode: FleetMode): void {
  try {
    ipcBridge.fleet.modeChanged.emit({ mode });
  } catch (e) {
    logNonCritical('fleet.emit.mode-changed', e);
  }
}
