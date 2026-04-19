/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

//子进程实例
/**
 * 提供进程启动
 * 提供主/子进程间通信功能
 */

import { uuid } from '@/renderer/utils/common';
import { getPlatformServices } from '@/common/platform';
import type { IWorkerProcess } from '@/common/platform';
import { getEnhancedEnv } from '@process/utils/shellEnv';
import type { MainToWorkerMessage } from '../WorkerProtocol';
import { Pipe } from './pipe';

/**
 * Shared registry of live ForkTasks. The previous implementation added one
 * `process.on('exit')` listener per ForkTask instance — with 11+ active
 * agents that tripped Node's default MaxListeners=10 cap and emitted a
 * MaxListenersExceededWarning on every team launch.
 *
 * Instead we keep a single module-level Set and install ONE process-exit
 * listener (lazily, on first ForkTask construction) that iterates the set
 * and kills each task. Individual tasks register/deregister themselves in
 * the Set. Behavior on process exit is unchanged — every child still gets
 * killed — but the number of listeners on `process` stays at exactly one
 * regardless of team size.
 */
const activeForkTasks = new Set<ForkTaskKillable>();
let processExitListenerInstalled = false;

/** Minimal shape ForkTask needs the registry to call on exit. */
type ForkTaskKillable = { kill: () => void };

function ensureProcessExitListener(): void {
  if (processExitListenerInstalled) return;
  processExitListenerInstalled = true;
  process.on('exit', () => {
    for (const task of activeForkTasks) {
      try {
        task.kill();
      } catch {
        // Cleanup on exit is best-effort; swallow errors so one
        // wedged task doesn't prevent others from being killed.
      }
    }
  });
}

export class ForkTask<Data> extends Pipe {
  protected path = '';
  protected data: Data;
  protected fcp: IWorkerProcess | undefined;
  private enableFork: boolean;
  private registered = false;
  constructor(path: string, data: Data, enableFork = true) {
    super(true);
    this.path = path;
    this.data = data;
    this.enableFork = enableFork;
    ensureProcessExitListener();
    activeForkTasks.add(this);
    this.registered = true;
    if (this.enableFork) this.init();
  }
  kill() {
    if (this.fcp) {
      this.fcp.kill();
    }
    if (this.registered) {
      activeForkTasks.delete(this);
      this.registered = false;
    }
  }
  protected init() {
    const platform = getPlatformServices();
    // In packaged Electron builds, resolve to app.asar.unpacked for WASM files.
    const workerCwd = platform.paths.isPackaged()
      ? (platform.paths.getAppPath() ?? process.cwd()).replace('app.asar', 'app.asar.unpacked')
      : process.cwd();
    // Pass enhanced shell environment so workers inherit the full PATH (nvm, npm globals, etc.)
    // This is critical for skills that depend on globally installed tools (node, npm, playwright, etc.)
    // Without this, workers only get Electron's limited env, missing paths set in .zshrc/.bashrc
    const workerEnv = getEnhancedEnv();
    const fcp = platform.worker.fork(this.path, [], {
      cwd: workerCwd,
      env: workerEnv,
    });
    // 接受子进程发送的消息
    fcp.on('message', (...args: unknown[]) => {
      const e = args[0] as IForkData;
      if (e.type === 'complete') {
        fcp.kill();
        this.emit('complete', e.data);
      } else if (e.type === 'error') {
        fcp.kill();
        this.emit('error', e.data);
      } else {
        // clientId约束为主/子进程间通信钥匙
        // 如果有clientId则向指定通道发起信息
        const deferred = this.deferred(e.pipeId);
        if (e.pipeId) {
          // 如果存在回调，则将回调信息发送到子进程
          Promise.resolve(deferred.pipe(this.postMessage.bind(this))).catch((error) => {
            console.error('Failed to pipe message:', error);
          });
        }
        return this.emit(e.type, e.data, deferred);
      }
    });
    fcp.on('error', (...args: unknown[]) => {
      this.emit('error', args[0] as Error);
    });
    // v2.1.0 [CRIT]: auto-cleanup on child exit. Previously if the
    // child crashed or exited without kill() being called, the task
    // stayed in activeForkTasks forever — one leaked reference per
    // crashed agent run, which adds up fast over long sessions.
    // 'close' fires after 'exit' and after all stdio has closed, so
    // it's the safest terminal event to hook.
    fcp.on('close', () => {
      if (this.registered) {
        activeForkTasks.delete(this);
        this.registered = false;
      }
    });
    this.fcp = fcp;
  }
  start() {
    if (!this.enableFork) return Promise.resolve();
    const { data } = this;
    return this.postMessagePromise('start', data);
  }
  // 向子进程发送消息并等待回调
  protected postMessagePromise(type: string, data: any) {
    return new Promise<any>((resolve, reject) => {
      const pipeId = uuid(8);
      // console.log("---------发送消息>", this.callbackKey(pipeId), type, data);
      this.once(this.callbackKey(pipeId), (data) => {
        // console.log("---------子进程消息加调监听>", data);
        if (data.state === 'fulfilled') {
          resolve(data.data);
        } else {
          reject(data.data);
        }
      });
      this.postMessage(type, data, { pipeId });
    });
  }
  // 向子进程发送回调
  postMessage(type: MainToWorkerMessage['type'] | string, data: unknown, extPrams: Record<string, unknown> = {}) {
    if (!this.fcp) throw new Error('fork task not enabled');
    this.fcp.postMessage({ type, data, ...extPrams });
  }
}

interface IForkData {
  type: 'complete' | 'error' | string;
  data: any;
  pipeId?: string;
  [key: string]: any;
}
