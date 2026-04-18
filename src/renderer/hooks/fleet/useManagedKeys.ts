/**
 * @license Apache-2.0
 * Managed-config-keys renderer hooks (Phase C Week 3).
 *
 * Master-managed keys are surfaced through three places in the UI:
 *   1. Lock icons on individual rows (IAM policies, security toggles)
 *   2. Disabled form controls so users can't attempt an edit that would
 *      get rejected at the IPC boundary
 *   3. A Settings → Fleet panel showing the full list
 *
 * All three read through this single SWR cache so flipping a key's
 * managed status (after a successful config-sync apply) updates every
 * consumer in one step. The cache revalidates automatically when
 * `ipcBridge.fleet.configApplied` fires — that event is emitted by the
 * slaveSync service immediately after each `applyConfigBundle` success.
 */

import { useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';

export const MANAGED_KEYS_SWR_KEY = 'fleet.managedKeys';
export const CONFIG_SYNC_STATUS_SWR_KEY = 'fleet.configSyncStatus';

export type ManagedKeyRow = {
  key: string;
  managedByVersion: number;
  appliedAt: number;
};

/**
 * Full list of master-managed keys with their version + apply timestamp.
 * Used by the Fleet-sync panel to render the governed-keys table.
 */
export function useManagedKeys(): { keys: ManagedKeyRow[]; isLoading: boolean } {
  const { data, isLoading, mutate } = useSWR<{ keys: ManagedKeyRow[] }>(MANAGED_KEYS_SWR_KEY, () =>
    ipcBridge.fleet.listManagedKeys.invoke()
  );

  // Re-fetch on every config-apply event so lock icons appear immediately
  // after master pushes a new bundle, without a page refresh.
  useEffect(() => {
    const unsub = ipcBridge.fleet.configApplied.on(() => {
      void mutate();
    });
    return () => {
      unsub?.();
    };
  }, [mutate]);

  return { keys: data?.keys ?? [], isLoading };
}

/**
 * Convenience predicate built on top of useManagedKeys — avoids an IPC
 * round-trip per row by indexing the list in memory. Use this for lock
 * icons in long tables (IAM policies, security features).
 */
export function useIsKeyManaged(): (key: string) => boolean {
  const { keys } = useManagedKeys();
  const indexed = useMemo(() => {
    const s = new Set<string>();
    for (const row of keys) s.add(row.key);
    return s;
  }, [keys]);
  return (key: string) => indexed.has(key);
}

/**
 * Slave-side config sync status — running flag, last-poll timestamp,
 * last-applied version, last error. Used by the Fleet-sync panel.
 * Polls at 30 s (same cadence as the poller itself) as a safety net in
 * case the configApplied emitter drops an event; the emitter path handles
 * the normal refresh case.
 */
export type ConfigSyncStatus = {
  running: boolean;
  lastPollAt?: number;
  lastAppliedVersion?: number;
  lastErrorMessage?: string;
};

export function useConfigSyncStatus(): { data: ConfigSyncStatus | undefined; isLoading: boolean; refresh: () => void } {
  const { data, isLoading, mutate } = useSWR<ConfigSyncStatus>(
    CONFIG_SYNC_STATUS_SWR_KEY,
    () => ipcBridge.fleet.getConfigSyncStatus.invoke(),
    { refreshInterval: 30_000 }
  );

  useEffect(() => {
    const unsub = ipcBridge.fleet.configApplied.on(() => {
      void mutate();
    });
    return () => {
      unsub?.();
    };
  }, [mutate]);

  return { data, isLoading, refresh: () => void mutate() };
}
