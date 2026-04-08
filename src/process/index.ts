/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import '@/common/platform/register-electron';
// configureChromium sets app name (dev isolation) and Chromium flags — must run before other modules
import '@process/utils/configureChromium';

import { app } from 'electron';

// Force node-gyp-build to skip build/ directory and use prebuilds/ only in production
// This prevents loading wrong architecture binaries from development environment
// Only apply in packaged app to allow development builds to use build/Release/
if (app.isPackaged) {
  process.env.PREBUILDS_ONLY = '1';
}
import initStorage from './utils/initStorage';
import './utils/initBridge';
import './services/i18n'; // Initialize i18n for main process
import { getChannelManager } from '@process/channels';
import { ExtensionRegistry } from '@process/extensions';

/**
 * Phase 1: Essential initialization required before the window can be created.
 * Initializes storage, bridges, and i18n — the minimum needed for IPC and config.
 */
export const initializeEssentials = async () => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[AionUi:process] ${label} +${Math.round(performance.now() - t0)}ms`);

  await initStorage();
  mark('initStorage');
};

/**
 * Phase 2: Deferred initialization that can run after the window is shown.
 * Extensions and channels are not needed before the renderer starts loading.
 */
export const initializeDeferred = async () => {
  await Promise.all([
    ExtensionRegistry.getInstance()
      .initialize()
      .catch((error) => {
        console.error('[Process] Failed to initialize ExtensionRegistry:', error);
      }),
    getChannelManager()
      .initialize()
      .catch((error) => {
        console.error('[Process] Failed to initialize ChannelManager:', error);
      }),
  ]);
};

/** Full initialization (both phases). Used by standalone server mode. */
export const initializeProcess = async () => {
  await initializeEssentials();
  await initializeDeferred();
};
