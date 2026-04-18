/**
 * @license Apache-2.0
 * Fleet telemetry renderer hooks (Phase D Week 3).
 *
 * Two hooks for the master dashboard:
 *   - useFleetTelemetrySummary(windowStart, windowEnd): fleet-wide
 *     rollup — total cost, active devices, top-N devices.
 *   - useDeviceTelemetry(deviceId, limit): per-device drill-down — the
 *     most recent N report windows for one device.
 *
 * Refreshes every 60s as a fallback (ingest cadence is 6h, so there's
 * no value polling faster). The dashboard is primarily a "glance at
 * yesterday's cost" tool, not a realtime monitor.
 */

import useSWR from 'swr';
import { ipcBridge } from '@/common';

const REFRESH_INTERVAL_MS = 60_000;

export type FleetTelemetrySummary = {
  totalCostCents: number;
  activeDevices: number;
  topDevices: Array<{
    deviceId: string;
    hostname?: string;
    costCents: number;
    activityCount: number;
    lastReportAt: number;
  }>;
};

export type DeviceTelemetryReport = {
  deviceId: string;
  windowStart: number;
  windowEnd: number;
  totalCostCents: number;
  activityCount: number;
  toolCallCount: number;
  policyViolationCount: number;
  agentCount: number;
  topActions: Array<{ action: string; count: number }>;
  receivedAt: number;
};

export function useFleetTelemetrySummary(
  windowStart: number,
  windowEnd: number,
  topDevicesLimit = 10
): { data: FleetTelemetrySummary | undefined; isLoading: boolean; refresh: () => void } {
  const swrKey = ['fleet.telemetry.summary', windowStart, windowEnd, topDevicesLimit] as const;
  const { data, isLoading, mutate } = useSWR<FleetTelemetrySummary>(
    swrKey,
    () => ipcBridge.fleet.getFleetTelemetrySummary.invoke({ windowStart, windowEnd, topDevicesLimit }),
    { refreshInterval: REFRESH_INTERVAL_MS }
  );
  return { data, isLoading, refresh: () => void mutate() };
}

export function useDeviceTelemetry(
  deviceId: string | null,
  limit = 50
): { reports: DeviceTelemetryReport[]; isLoading: boolean; refresh: () => void } {
  const swrKey = deviceId ? (['fleet.telemetry.device', deviceId, limit] as const) : null;
  const { data, isLoading, mutate } = useSWR<{ reports: DeviceTelemetryReport[] }>(
    swrKey,
    () => {
      if (!deviceId) throw new Error('deviceId required');
      return ipcBridge.fleet.getDeviceTelemetry.invoke({ deviceId, limit });
    }
  );
  return {
    reports: data?.reports ?? [],
    isLoading,
    refresh: () => void mutate(),
  };
}

// ── Window helpers for the selector ──────────────────────────────────────

export type DashboardWindow = '24h' | '7d' | '30d' | '90d';

/**
 * Compute [windowStart, windowEnd) for a named time window. `now` is a
 * parameter (not Date.now()) so components can share one reference and
 * stay in sync when the user hits Refresh.
 */
export function resolveWindow(
  name: DashboardWindow,
  now: number = Date.now()
): { windowStart: number; windowEnd: number } {
  const windowEnd = now;
  const durations: Record<DashboardWindow, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  };
  return { windowStart: windowEnd - durations[name], windowEnd };
}
