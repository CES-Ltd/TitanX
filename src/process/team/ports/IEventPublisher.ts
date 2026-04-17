/**
 * @license Apache-2.0
 * IEventPublisher — narrow port abstracting the cross-process event
 * publishing that team services currently perform via the global
 * ipcBridge.
 *
 * Why this exists:
 *   TeammateManager, TaskManager, and activityLog all need to emit live
 *   events to the renderer. They do this today by:
 *     - statically importing { ipcBridge } from '@/common' (TeammateManager)
 *     - dynamically require('@/common') to work around a circular
 *       dependency (TaskManager.ts, activityLog/index.ts)
 *
 *   That circular require is a red flag: common/ should NOT depend on
 *   process/team/, and process/team/ should NOT depend on common/ runtime
 *   modules — only common/ types.
 *
 *   This port lets process-layer code depend only on an interface that
 *   lives inside process/team/. The concrete IPC-backed implementation is
 *   wired at app startup (see defaultIpcEventPublisher.ts) and injected
 *   into services via their constructors. Tests can inject a no-op mock
 *   without pulling in electron + ipcBridge.
 *
 *   Scope is deliberately minimal: only the events the team + audit log
 *   actually publish. Other bridge events stay on the existing ipcBridge
 *   until their callers are migrated in follow-up passes.
 */

import type {
  ITeamAgentStatusEvent,
  ITeamAgentSpawnedEvent,
  ITeamAgentRemovedEvent,
  ITeamAgentRenamedEvent,
  ITeamMessageEvent,
} from '@/common/types/teamTypes';
import type { IActivityEntry } from '@/common/adapter/ipcBridge';

/**
 * Type-safe event map. Adding a new event type requires extending both
 * this union and the publisher's switch. That's the whole point — no
 * more stringly-typed emits with untyped payloads.
 */
export type TeamEventMap = {
  'team.agent-status-changed': ITeamAgentStatusEvent;
  'team.message-stream': ITeamMessageEvent;
  'team.agent-spawned': ITeamAgentSpawnedEvent;
  'team.agent-removed': ITeamAgentRemovedEvent;
  'team.agent-renamed': ITeamAgentRenamedEvent;
  'live.activity': IActivityEntry;
};

export type TeamEventName = keyof TeamEventMap;

/** Narrow publisher interface — one method, type-safe by event name. */
export interface IEventPublisher {
  emit<K extends TeamEventName>(event: K, payload: TeamEventMap[K]): void;
}

/** No-op publisher for tests + contexts that don't have a renderer. */
export const NoopEventPublisher: IEventPublisher = {
  emit: () => {
    /* silent */
  },
};
