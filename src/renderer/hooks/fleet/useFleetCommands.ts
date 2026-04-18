/**
 * @license Apache-2.0
 * Fleet commands renderer hooks (Phase F Week 3).
 *
 * One hook for the history table + one for the drill-down. The history
 * cache auto-refreshes on every `fleet:command-acked` event so the
 * admin watches ack counts tick up in real time as slaves check in.
 */

import { useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';

const REFRESH_INTERVAL_MS = 30_000;

export type FleetCommandType =
  | 'force_config_sync'
  | 'force_telemetry_push'
  | 'cache.clear'
  | 'credential.rotate'
  | 'agent.restart'
  | 'force.upgrade'
  | 'agent.execute';
export type AckStatus = 'succeeded' | 'failed' | 'skipped';

export type FleetCommandRow = {
  id: string;
  targetDeviceId: string;
  commandType: FleetCommandType;
  params: Record<string, unknown>;
  createdAt: number;
  createdBy: string;
  expiresAt: number;
  revokedAt?: number;
  acks: {
    succeeded: number;
    failed: number;
    skipped: number;
    total: number;
    lastAckedAt?: number;
  };
};

export type FleetCommandAckRow = {
  commandId: string;
  deviceId: string;
  status: AckStatus;
  result: Record<string, unknown>;
  ackedAt: number;
};

/**
 * Recent commands with rolled-up ack counts. Auto-refreshes on every
 * `fleet:command-acked` event (real-time feel — a slave ack from 30s
 * ago becomes visible within a render frame) plus a 30 s safety net.
 */
export function useFleetCommandHistory(limit = 50): {
  commands: FleetCommandRow[];
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, isLoading, mutate } = useSWR<{ commands: FleetCommandRow[] }>(
    ['fleet.commands.history', limit],
    () => ipcBridge.fleet.listCommands.invoke({ limit }),
    { refreshInterval: REFRESH_INTERVAL_MS }
  );

  useEffect(() => {
    const unsub = ipcBridge.fleet.commandAcked.on(() => {
      void mutate();
    });
    return () => {
      unsub?.();
    };
  }, [mutate]);

  return {
    commands: data?.commands ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}

/**
 * Per-device ack rows for one command. Null `commandId` disables the
 * SWR fetch — the drill-down modal uses this so unmounting doesn't
 * leave a pointless background refresh running.
 */
export function useCommandAcks(commandId: string | null): {
  acks: FleetCommandAckRow[];
  isLoading: boolean;
  refresh: () => void;
} {
  const swrKey = commandId ? (['fleet.commands.acks', commandId] as const) : null;
  const { data, isLoading, mutate } = useSWR<{ acks: FleetCommandAckRow[] }>(swrKey, () => {
    if (!commandId) throw new Error('commandId required');
    return ipcBridge.fleet.listCommandAcks.invoke({ commandId });
  });

  useEffect(() => {
    if (!commandId) return;
    const unsub = ipcBridge.fleet.commandAcked.on((evt: { commandId: string }) => {
      if (evt.commandId === commandId) void mutate();
    });
    return () => {
      unsub?.();
    };
  }, [commandId, mutate]);

  return {
    acks: data?.acks ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}

/**
 * Wrapper around the enqueue IPC with a typed union-return so callers
 * can branch on `ok` without type guards. Doesn't do SWR on its own
 * (caller passes the history's `refresh` after a successful enqueue).
 */
export async function enqueueFleetCommand(input: {
  targetDeviceId: string;
  commandType: 'force_config_sync' | 'force_telemetry_push';
  ttlSeconds?: number;
}): Promise<{ ok: true; commandId: string } | { ok: false; error: string; code?: 'per_device' | 'fleet_wide' }> {
  return ipcBridge.fleet.enqueueCommand.invoke(input);
}

export async function revokeFleetCommand(commandId: string): Promise<{ ok: boolean }> {
  return ipcBridge.fleet.revokeCommand.invoke({ commandId });
}
