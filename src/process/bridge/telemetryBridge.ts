/**
 * @license Apache-2.0
 * Telemetry bridge — IPC handlers for OpenTelemetry configuration.
 * Stores config in ProcessConfig and initializes/restarts the SDK.
 */

import { ipcBridge } from '@/common';
import { ProcessConfig } from '@process/utils/initStorage';
import {
  initTelemetry,
  restartTelemetry,
  getTelemetryConfig,
  DEFAULT_TELEMETRY_CONFIG,
} from '@process/services/telemetry';
import type { TelemetryConfig } from '@process/services/telemetry';

const CONFIG_KEY = 'telemetry.config';

export function initTelemetryBridge(): void {
  // Get current telemetry configuration
  ipcBridge.telemetry.getConfig.provider(async () => {
    const stored = await ProcessConfig.get(CONFIG_KEY);
    if (stored && typeof stored === 'object') {
      return { ...DEFAULT_TELEMETRY_CONFIG, ...stored } as TelemetryConfig;
    }
    return getTelemetryConfig();
  });

  // Set telemetry configuration and apply immediately
  ipcBridge.telemetry.setConfig.provider(async (config) => {
    await ProcessConfig.set(CONFIG_KEY, config);
    await restartTelemetry(config);
    console.log(`[TelemetryBridge] Config updated: enabled=${config.enabled}, exporter=${config.exporterType}`);
  });

  // Restart telemetry with current stored config
  ipcBridge.telemetry.restart.provider(async () => {
    const stored = await ProcessConfig.get(CONFIG_KEY);
    const config =
      stored && typeof stored === 'object'
        ? ({ ...DEFAULT_TELEMETRY_CONFIG, ...stored } as TelemetryConfig)
        : DEFAULT_TELEMETRY_CONFIG;
    await restartTelemetry(config);
  });

  // Initialize telemetry on bridge init with stored config
  void (async () => {
    try {
      const stored = await ProcessConfig.get(CONFIG_KEY);
      if (stored && typeof stored === 'object') {
        const config = { ...DEFAULT_TELEMETRY_CONFIG, ...stored } as TelemetryConfig;
        await initTelemetry(config);
      }
    } catch {
      // Non-critical: telemetry starts disabled
    }
  })();
}
