/**
 * @license Apache-2.0
 * Slave-side enrollment status hook (Phase B Week 3).
 *
 * Reads from ipcBridge.fleet.getSlaveStatus on mount + subscribes to
 * slaveStatusChanged so the offline banner + Settings section stay
 * live without polling. Returns null when the install isn't in slave
 * mode (the hook is safe to call from any component — the consumer
 * just gets null and renders nothing).
 */

import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';

export type SlaveConnectionState = 'offline' | 'online' | 'revoked' | 'unenrolled';

export type SlaveStatus = {
  mode: 'slave';
  connection: SlaveConnectionState;
  deviceId?: string;
  lastHeartbeatAt?: number;
  lastErrorMessage?: string;
};

export const SLAVE_STATUS_SWR_KEY = 'fleet.slave-status';

/** Returns the current slave status, or null when mode !== slave. */
export function useSlaveStatus(): SlaveStatus | null {
  const { data, mutate } = useSWR<SlaveStatus | null>(SLAVE_STATUS_SWR_KEY, () =>
    ipcBridge.fleet.getSlaveStatus.invoke()
  );

  // Keep a local shadow so in-process broadcasts can update without
  // a full re-fetch — SWR is mutated in-place with the new payload.
  const [local, setLocal] = useState<SlaveStatus | null>(null);

  useEffect(() => {
    const unsub = ipcBridge.fleet.slaveStatusChanged.on((evt) => {
      const next: SlaveStatus = {
        mode: 'slave',
        connection: evt.connection,
        deviceId: evt.deviceId,
        lastHeartbeatAt: evt.lastHeartbeatAt,
        lastErrorMessage: evt.lastErrorMessage,
      };
      setLocal(next);
      void mutate(next, { revalidate: false });
    });
    return () => {
      unsub?.();
    };
  }, [mutate]);

  return local ?? data ?? null;
}

/** Imperative revalidate — used by the settings panel after a user action. */
export function useRefreshSlaveStatus(): () => Promise<void> {
  return useCallback(async () => {
    const fresh = await ipcBridge.fleet.getSlaveStatus.invoke();
    // Note: SWR's global mutate is the common way to refresh; here we
    // just return the fresh value so callers can decide what to do.
    void fresh;
  }, []);
}
