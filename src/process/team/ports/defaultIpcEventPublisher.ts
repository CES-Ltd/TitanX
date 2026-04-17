/**
 * @license Apache-2.0
 * Default IPC-backed implementation of IEventPublisher.
 *
 * Translates typed event names to the appropriate emitter on the global
 * ipcBridge. Single source of truth for the event-name → bridge-channel
 * mapping — callers never have to know which bridge namespace owns which
 * event, and TypeScript enforces payload shape at every emit site.
 */

import type { IEventPublisher, TeamEventMap, TeamEventName } from './IEventPublisher';
import { ipcBridge } from '@/common';
import { logNonCritical } from '@process/utils/logNonCritical';

/**
 * Create an IPC-backed publisher. Takes a lazy ipcBridge resolver so the
 * publisher itself has no startup-time coupling on ipcBridge being ready.
 * Default resolver uses the app's global bridge.
 */
export function createIpcEventPublisher(): IEventPublisher {
  return {
    emit<K extends TeamEventName>(event: K, payload: TeamEventMap[K]): void {
      try {
        switch (event) {
          case 'team.agent-status-changed':
            ipcBridge.team.agentStatusChanged.emit(payload as TeamEventMap['team.agent-status-changed']);
            return;
          case 'team.message-stream':
            ipcBridge.team.messageStream.emit(payload as TeamEventMap['team.message-stream']);
            return;
          case 'team.agent-spawned':
            ipcBridge.team.agentSpawned.emit(payload as TeamEventMap['team.agent-spawned']);
            return;
          case 'team.agent-removed':
            ipcBridge.team.agentRemoved.emit(payload as TeamEventMap['team.agent-removed']);
            return;
          case 'team.agent-renamed':
            ipcBridge.team.agentRenamed.emit(payload as TeamEventMap['team.agent-renamed']);
            return;
          case 'live.activity':
            ipcBridge.liveEvents.activity.emit(payload as TeamEventMap['live.activity']);
            return;
          default: {
            const _exhaustive: never = event;
            void _exhaustive;
          }
        }
      } catch (e) {
        // IPC emission should never crash the main process. Log for observability.
        logNonCritical(`ipc-publish.${event}`, e);
      }
    },
  };
}

/** Shared singleton for services that don't receive a publisher via DI. */
let _shared: IEventPublisher | null = null;
export function getSharedEventPublisher(): IEventPublisher {
  if (!_shared) _shared = createIpcEventPublisher();
  return _shared;
}

/** Override the singleton (tests only). */
export function _setSharedEventPublisherForTests(publisher: IEventPublisher | null): void {
  _shared = publisher;
}
