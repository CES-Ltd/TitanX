/**
 * @license Apache-2.0
 * LocalAgentAdapter — thin IAgent implementation for local-backend team
 * agents. Delegates wake() to an injected TeammateManager-compatible
 * caller so this module has zero direct coupling to `TeammateManager`
 * (which lives in a separate dependency graph and carries heavy
 * imports like Electron IPC).
 *
 * Phase A v1.9.40 intent: this adapter exists so AgentAdapterRegistry
 * has a registered factory for backend='local'. Existing wake call
 * sites still go through `TeammateManager.wake()` directly — nothing
 * is migrated yet. Phase B registers the parallel farm adapter that
 * implements the same IAgent contract, at which point higher layers
 * can be flipped to the registry-mediated lookup without a rewrite.
 *
 * Messages arg is currently ignored: the underlying wake pulls unread
 * messages from the slot's mailbox itself. The signature still accepts
 * messages so LocalAgentAdapter and FleetAgentAdapter share the same
 * IAgent interface — Phase B's farm adapter forwards the caller's
 * messages over the command channel.
 */

import { fromUnknown } from '@/common/types/errors';
import type { AgentMessage, AgentWakeResult, FleetBinding, IAgent } from '../ports/IAgent';

/**
 * Injected contract — whatever object can perform a wake on a slotId.
 * In production it's the TeammateManager singleton for the target team.
 * In tests it's a stub. Keeps this adapter dependency-free at the
 * module level.
 */
export type LocalWakeDispatcher = {
  wake(slotId: string, messages?: AgentMessage[]): Promise<void>;
};

export function createLocalAgentAdapter(
  descriptor: {
    slotId: string;
    displayName: string;
  },
  dispatcher: LocalWakeDispatcher
): IAgent {
  return {
    slotId: descriptor.slotId,
    displayName: descriptor.displayName,
    backend: 'local',
    fleetBinding: undefined as FleetBinding | undefined,
    async wake(messages?: AgentMessage[]): Promise<AgentWakeResult> {
      try {
        await dispatcher.wake(descriptor.slotId, messages);
        // The existing wake pipeline emits results via IPC events +
        // writes to cost/activity tables. The IAgent contract returns
        // a simple "ok" with an empty assistantText so higher layers
        // can transition from string-parsing to structured results
        // incrementally.
        //
        // Phase B's farm adapter will fill in assistantText + usage
        // from the slave's ack payload. Until the local wake pipeline
        // is refactored to surface that data through the adapter, this
        // adapter reports ok with a sentinel — callers that care about
        // the actual text still subscribe to the existing IPC event.
        return {
          ok: true,
          assistantText: '',
        };
      } catch (e) {
        return {
          ok: false,
          failure: fromUnknown(e, 'internal'),
        };
      }
    },
  };
}
