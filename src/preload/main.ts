/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { ADAPTER_BRIDGE_EVENT_KEY } from '../common/adapter/constant';

// ── IPC Channel Whitelist ──────────────────────────────────────────────────
// Security: Only whitelisted IPC channels are allowed through the preload bridge.
// Prevents renderer-side exploits from calling arbitrary main process functions.
// Inspired by ClawX's IPC channel whitelist enforcement.
const ALLOWED_DIRECT_CHANNELS = new Set([
  ADAPTER_BRIDGE_EVENT_KEY,
  'webui-direct-reset-password',
  'webui-direct-get-status',
  'webui-direct-change-password',
  'webui-direct-change-username',
  'webui-direct-generate-qr-token',
  'weixin:login:start',
  'show-open-request',
]);

const ALLOWED_LISTEN_CHANNELS = new Set([
  ADAPTER_BRIDGE_EVENT_KEY,
  'weixin:login:qr',
  'weixin:login:scanned',
  'weixin:login:done',
  'tray:navigate-to-guid',
  'tray:navigate-to-conversation',
  'tray:open-about',
  'tray:pause-all-tasks',
  'tray:check-update',
]);

/**
 * Validate that an IPC channel is whitelisted before invoking or listening.
 */
function assertAllowedChannel(channel: string, allowedSet: Set<string>): void {
  if (!allowedSet.has(channel)) {
    console.warn(`[Security] Blocked IPC channel: ${channel}`);
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

/**
 * @description 注入到renderer进程中, 用于与main进程通信
 * */
contextBridge.exposeInMainWorld('electronAPI', {
  emit: (name: string, data: any) => {
    // All bridge messages go through the single adapter channel — validated at registration
    assertAllowedChannel(ADAPTER_BRIDGE_EVENT_KEY, ALLOWED_DIRECT_CHANNELS);
    return ipcRenderer
      .invoke(
        ADAPTER_BRIDGE_EVENT_KEY,
        JSON.stringify({
          name: name,
          data: data,
        })
      )
      .catch((error) => {
        console.error('IPC invoke error:', error);
        throw error;
      });
  },
  on: (callback: any) => {
    assertAllowedChannel(ADAPTER_BRIDGE_EVENT_KEY, ALLOWED_LISTEN_CHANNELS);
    const handler = (event: any, value: any) => {
      callback({ event, value });
    };
    ipcRenderer.on(ADAPTER_BRIDGE_EVENT_KEY, handler);
    return () => {
      ipcRenderer.off(ADAPTER_BRIDGE_EVENT_KEY, handler);
    };
  },
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // 直接 IPC 调用（绕过 bridge 库）/ Direct IPC calls (bypass bridge library)
  webuiResetPassword: () => ipcRenderer.invoke('webui-direct-reset-password'),
  webuiGetStatus: () => ipcRenderer.invoke('webui-direct-get-status'),
  // 修改密码不需要当前密码 / Change password without current password
  webuiChangePassword: (newPassword: string) => ipcRenderer.invoke('webui-direct-change-password', { newPassword }),
  webuiChangeUsername: (newUsername: string) => ipcRenderer.invoke('webui-direct-change-username', { newUsername }),
  // 生��二维码 token / Generate QR token
  webuiGenerateQRToken: () => ipcRenderer.invoke('webui-direct-generate-qr-token'),
  // WeChat login IPC
  weixinLoginStart: () => ipcRenderer.invoke('weixin:login:start'),
  weixinLoginOnQR: (callback: (data: { qrcodeUrl: string }) => void) => {
    const h = (_event: unknown, data: { qrcodeUrl: string }) => callback(data);
    ipcRenderer.on('weixin:login:qr', h);
    return () => ipcRenderer.off('weixin:login:qr', h);
  },
  weixinLoginOnScanned: (callback: () => void) => {
    const h = () => callback();
    ipcRenderer.on('weixin:login:scanned', h);
    return () => ipcRenderer.off('weixin:login:scanned', h);
  },
  weixinLoginOnDone: (callback: (data: { accountId: string }) => void) => {
    const h = (_event: unknown, data: { accountId: string }) => callback(data);
    ipcRenderer.on('weixin:login:done', h);
    return () => ipcRenderer.off('weixin:login:done', h);
  },
});

// 托盘事件监听 - 将 IPC 事件转换为 DOM 事件
// Tray event listeners - convert IPC events to DOM events
const trayEvents = [
  'tray:navigate-to-guid',
  'tray:navigate-to-conversation',
  'tray:open-about',
  'tray:pause-all-tasks',
  'tray:check-update',
];

for (const channel of trayEvents) {
  ipcRenderer.on(channel, (_event, ...args) => {
    window.dispatchEvent(new CustomEvent(channel, { detail: args[0] }));
  });
}
