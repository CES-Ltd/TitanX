/**
 * @license Apache-2.0
 * Fleet Farm renderer hooks (Phase B, v1.10.0).
 *
 * Three hooks:
 *   - useFarmDevices()      — list of farm-role devices for pickers
 *   - useFarmJobSummary()   — per-device rollups for the dashboard
 *   - useFarmJobs()         — recent jobs table, optional per-device
 *
 * All use SWR with a 30-second refresh. Farm-job activity is typically
 * high-frequency; picking a coarser interval than the 60s telemetry
 * refresh is intentional so the dashboard feels live under load.
 */

import useSWR from 'swr';
import { useEffect } from 'react';
import { ipcBridge } from '@/common';

const REFRESH_INTERVAL_MS = 30_000;

export type FarmDeviceRuntime = {
  backend: string;
  name: string;
  cliAvailable: boolean;
};

export type FarmDevice = {
  deviceId: string;
  hostname: string;
  osVersion: string;
  titanxVersion: string;
  enrolledAt: number;
  lastHeartbeatAt?: number;
  capabilities: Record<string, unknown>;
  /**
   * v2.2.1 — detected ACP runtimes (Claude Code CLI, OpenCode, Codex,
   * Gemini, etc.) from the device's most recent telemetry push.
   * Undefined means "no telemetry yet OR slave is pre-v2.2.1"; empty
   * array means "slave pushed, has zero detected runtimes".
   * HireFarmAgentModal distinguishes the two to avoid blocking
   * on unknown.
   */
  runtimes?: FarmDeviceRuntime[];
};

export type FarmJobSummary = {
  deviceId: string;
  jobsTotal: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsTimeout: number;
  avgLatencyMs: number;
  lastJobAt: number | null;
};

export type FarmJobStatus = 'queued' | 'dispatched' | 'running' | 'completed' | 'failed' | 'timeout';

export type FarmJobRow = {
  id: string;
  deviceId: string;
  teamId: string;
  agentSlotId: string;
  requestPayload: Record<string, unknown>;
  responsePayload: Record<string, unknown> | null;
  status: FarmJobStatus;
  error: string | null;
  enqueuedAt: number;
  dispatchedAt: number | null;
  completedAt: number | null;
};

export function useFarmDevices(): {
  devices: FarmDevice[];
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, isLoading, mutate } = useSWR<{ devices: FarmDevice[] }>(
    ['fleet.farm-devices'],
    () => ipcBridge.fleet.listFarmDevices.invoke(),
    { refreshInterval: REFRESH_INTERVAL_MS }
  );
  // v2.2.2 — subscribe to the master-side telemetry-received IPC
  // event so the hire modal picks up a slave's first v2.2.1+
  // runtime report within seconds of it landing, not on the 30s poll
  // tick. The emitter is fired from fleetRoutes after a successful
  // ingest.
  useEffect(() => {
    const off = ipcBridge.fleet.telemetryReceived.on(() => {
      void mutate();
    });
    return () => {
      // Arco/IPC emitter unsubscribe returns void; wrap defensively.
      try {
        off();
      } catch {
        /* noop */
      }
    };
  }, [mutate]);
  return {
    devices: data?.devices ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}

export function useFarmJobSummary(
  windowStart: number,
  windowEnd: number
): {
  summary: FarmJobSummary[];
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, isLoading, mutate } = useSWR<{ devices: FarmJobSummary[] }>(
    ['fleet.farm-summary', windowStart, windowEnd],
    () => ipcBridge.fleet.getFarmJobSummary.invoke({ windowStart, windowEnd }),
    { refreshInterval: REFRESH_INTERVAL_MS }
  );
  return {
    summary: data?.devices ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}

export function useFarmJobs(
  deviceId: string | null,
  limit: number = 100
): {
  jobs: FarmJobRow[];
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, isLoading, mutate } = useSWR<{ jobs: FarmJobRow[] }>(
    ['fleet.farm-jobs', deviceId, limit],
    () => ipcBridge.fleet.listFarmJobs.invoke({ deviceId: deviceId ?? undefined, limit }),
    { refreshInterval: REFRESH_INTERVAL_MS }
  );
  return {
    jobs: data?.jobs ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}
