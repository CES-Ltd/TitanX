/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

import { bridge } from '@office-ai/platform';
import { ADAPTER_BRIDGE_EVENT_KEY } from './constant';
import { registerWebSocketBroadcaster, getBridgeEmitter, setBridgeEmitter, broadcastToAll } from './registry';

/**
 * Bridge event data structure for IPC communication
 * IPC 通信的桥接事件数据结构
 */
interface BridgeEventData {
  name: string;
  data: unknown;
}

const adapterWindowList: Array<BrowserWindow> = [];

export { registerWebSocketBroadcaster, getBridgeEmitter };

let petNotifyHook: ((name: string, data: unknown) => void) | null = null;

export const setPetNotifyHook = (hook: ((name: string, data: unknown) => void) | null): void => {
  petNotifyHook = hook;
};

/**
 * @description 建立与每一个browserWindow的通信桥梁
 * */
/** Maximum IPC payload size (50 MB). Messages exceeding this are dropped with an error notification. */
const MAX_IPC_PAYLOAD_SIZE = 50 * 1024 * 1024;

/** Maximum object depth when estimating payload size (guards against deeply nested attack payloads). */
const MAX_PAYLOAD_DEPTH = 64;
/** Maximum array/object property count before bailing early. */
const MAX_PAYLOAD_NODES = 100_000;

/**
 * Estimate the serialized size of `value` without materializing JSON.stringify output.
 * Walks the object graph with a budget (bytes, depth, nodes) and returns null if the
 * payload would exceed any limit — letting the caller reject it before a costly
 * stringify attempt or potential OOM on circular structures.
 */
function estimatePayloadSize(value: unknown, maxBytes: number): number | null {
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): boolean {
    if (depth > MAX_PAYLOAD_DEPTH) return false;
    if (++nodes > MAX_PAYLOAD_NODES) return false;
    if (v === null || v === undefined) {
      bytes += 4; // "null"
      return bytes <= maxBytes;
    }
    const t = typeof v;
    if (t === 'boolean') {
      bytes += 5;
    } else if (t === 'number' || t === 'bigint') {
      bytes += 20;
    } else if (t === 'string') {
      // JSON overhead: quotes + possible escapes (approx 1.1x)
      bytes += Math.ceil((v as string).length * 1.1) + 2;
    } else if (t === 'object') {
      if (seen.has(v as object)) return false; // cycle
      seen.add(v as object);
      if (Array.isArray(v)) {
        bytes += 2; // []
        for (const item of v) {
          if (!walk(item, depth + 1)) return false;
          bytes += 1; // comma
          if (bytes > maxBytes) return false;
        }
      } else {
        bytes += 2; // {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          bytes += k.length + 4; // "key":
          if (!walk(val, depth + 1)) return false;
          bytes += 1;
          if (bytes > maxBytes) return false;
        }
      }
    }
    return bytes <= maxBytes;
  }

  return walk(value, 0) ? bytes : null;
}

bridge.adapter({
  emit(name, data) {
    // Notify pet (if hook is set)
    if (petNotifyHook) {
      try {
        petNotifyHook(name, data);
      } catch {
        /* never crash */
      }
    }

    // Pre-flight estimate to reject oversized/cyclic/deeply-nested payloads BEFORE
    // the expensive JSON.stringify call, avoiding OOM on malicious structures.
    const estimated = estimatePayloadSize({ name, data }, MAX_IPC_PAYLOAD_SIZE);
    if (estimated === null) {
      console.error(`[adapter] Bridge event "${name}" rejected: exceeds size/depth/node budget before serialization`);
      return;
    }

    // 1. Send to all Electron BrowserWindows (skip destroyed ones)
    let serialized: string;
    try {
      serialized = JSON.stringify({ name, data });
    } catch (error) {
      // RangeError: Invalid string length — data too large to serialize
      console.error('[adapter] Failed to serialize bridge event:', name, error);
      return;
    }

    // Guard: reject oversized payloads to prevent main-process blocking
    if (serialized.length > MAX_IPC_PAYLOAD_SIZE) {
      console.error(
        `[adapter] Bridge event "${name}" too large (${(serialized.length / 1024 / 1024).toFixed(1)}MB), skipped`
      );
      const errorPayload = JSON.stringify({
        name: 'bridge:error',
        data: { originalEvent: name, reason: 'payload_too_large', size: serialized.length },
      });
      for (let i = adapterWindowList.length - 1; i >= 0; i--) {
        const win = adapterWindowList[i];
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(ADAPTER_BRIDGE_EVENT_KEY, errorPayload);
        }
      }
      return;
    }

    for (let i = adapterWindowList.length - 1; i >= 0; i--) {
      const win = adapterWindowList[i];
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        adapterWindowList.splice(i, 1);
        continue;
      }
      win.webContents.send(ADAPTER_BRIDGE_EVENT_KEY, serialized);
    }
    // 2. Also broadcast to all WebSocket clients
    broadcastToAll(name, data);
  },
  on(emitter) {
    // 保存 emitter 引用供 WebSocket 处理使用 / Save emitter reference for WebSocket handling
    setBridgeEmitter(emitter);

    ipcMain.handle(ADAPTER_BRIDGE_EVENT_KEY, (_event, info) => {
      const { name, data } = JSON.parse(info) as BridgeEventData;
      return Promise.resolve(emitter.emit(name, data));
    });
  },
});

export const initMainAdapterWithWindow = (win: BrowserWindow) => {
  adapterWindowList.push(win);
  const off = () => {
    const index = adapterWindowList.indexOf(win);
    if (index > -1) adapterWindowList.splice(index, 1);
  };
  win.on('closed', off);
  return off;
};
