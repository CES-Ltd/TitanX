/**
 * @license Apache-2.0
 * Fleet-mode renderer hooks (Phase A Week 2).
 *
 * Thin SWR wrappers over ipcBridge.fleet.*. Centralized here so the
 * Sidebar, RestrictedRoute, Settings switcher, and Wizard all read
 * from the same cache — flipping mode via `fleet.modeChanged` event
 * invalidates every consumer in one step.
 */

import { useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { FleetConfig, FleetMode } from '@/common/types/fleetTypes';

export const FLEET_MODE_SWR_KEY = 'fleet.mode';
export const FLEET_CONFIG_SWR_KEY = 'fleet.config';
export const FLEET_SETUP_REQUIRED_SWR_KEY = 'fleet.isSetupRequired';

/**
 * Returns the currently-active fleet mode. Defaults to `regular` while
 * the first IPC call is in-flight so no component briefly flashes a
 * hidden-by-slave state on boot.
 */
export function useFleetMode(): FleetMode {
  const { data = 'regular', mutate } = useSWR<FleetMode>(FLEET_MODE_SWR_KEY, () => ipcBridge.fleet.getMode.invoke());

  // Refresh when the process emits mode-changed (set from Settings
  // switcher or the wizard's completeSetup call). Keeps every
  // consumer in sync without polling.
  useEffect(() => {
    const unsub = ipcBridge.fleet.modeChanged.on((evt: { mode: FleetMode }) => {
      void mutate(evt.mode, { revalidate: false });
    });
    return () => {
      unsub?.();
    };
  }, [mutate]);

  return data;
}

/**
 * Full fleet config (mode + mode-specific subfields). Used by the
 * Settings switcher to preselect current port / URL values.
 */
export function useFleetConfig(): { data: FleetConfig | undefined; isLoading: boolean } {
  const { data, isLoading } = useSWR<FleetConfig>(FLEET_CONFIG_SWR_KEY, () => ipcBridge.fleet.getConfig.invoke());
  return { data, isLoading };
}

/**
 * Returns true when the setup wizard should open. Consumed by the
 * top-level Main component in main.tsx to gate the router.
 */
export function useFleetSetupRequired(): { required: boolean; isLoading: boolean } {
  const { data = false, isLoading } = useSWR<boolean>(FLEET_SETUP_REQUIRED_SWR_KEY, () =>
    ipcBridge.fleet.isSetupRequired.invoke()
  );
  return { required: data, isLoading };
}
