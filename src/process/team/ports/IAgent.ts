/**
 * @license Apache-2.0
 * IAgent — abstraction over "a waking agent slot" that hides whether
 * the agent runs locally on this install or on a remote farm device.
 *
 * Introduced in Phase A v1.9.40 as scaffolding for the Phase B Agent
 * Farm feature, where slaves expose compute nodes that the master
 * drives as if they were team members. Local agents remain untouched
 * today — the existing `TeammateManager.wake(slotId)` path is what
 * `LocalAgentAdapter` wraps without behavior change.
 *
 * Design intent:
 *   - `backend` tells the registry which adapter to dispatch to.
 *   - `fleetBinding` is present only when backend='farm'; local
 *     agents leave it undefined.
 *   - `wake()` returns a structured `AgentWakeResult` so the orchestrator
 *     can treat success, policy denial, timeout, unreachable-slave as
 *     first-class states (no string parsing).
 *
 * Messages are optional: for local agents the wake pulls them from the
 * slot's mailbox internally; for farm agents the master packages the
 * message payload before dispatching over the fleet command channel.
 */

import type { AgentFailure } from '@/common/types/errors';

export type AgentBackend = 'local' | 'farm';

export type FleetBinding = {
  /** The slave device hosting this agent (farm-mode only). */
  deviceId: string;
  /** The remote slotId on the slave's agent_gallery template instance. */
  remoteSlotId: string;
  /**
   * Allow-list of tools the master permits the remote agent to invoke.
   * Phase B farm executor enforces this at the slave boundary.
   */
  toolsAllowlist: string[];
};

/**
 * Minimum shape the registry exposes to the orchestrator. Full
 * implementations (LocalAgentAdapter, later FleetAgentAdapter) can
 * carry more state internally; this interface is what higher layers
 * depend on.
 */
export type IAgent = {
  /** Stable slot identifier (same as `TeamAgent.slotId`). */
  readonly slotId: string;
  /** Human-readable display name (shown in UI; maps to agentName today). */
  readonly displayName: string;
  /** Local-or-farm dispatch discriminator. */
  readonly backend: AgentBackend;
  /** Present only when backend='farm'. */
  readonly fleetBinding?: FleetBinding;
  /**
   * Kick off a wake cycle for this agent. Resolves when the turn
   * completes (either successfully or with a structured failure).
   * Messages are optional because local adapters source them from the
   * mailbox; farm adapters MUST supply them.
   */
  wake(messages?: AgentMessage[]): Promise<AgentWakeResult>;
};

/**
 * Message shape passed across the adapter boundary. Deliberately thin
 * — richer payload types (tool calls, attachments, reasoning) are the
 * adapter implementation's concern, not the interface's.
 */
export type AgentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Optional speaker name (e.g. which teammate wrote the message). */
  name?: string;
};

/** Result of one wake() call. Discriminated on `ok`. */
export type AgentWakeResult =
  | {
      ok: true;
      /** Textual assistant response (may be empty if action-only turn). */
      assistantText: string;
      /** Total usage for this turn; null if provider didn't report it. */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        costCents?: number;
      };
    }
  | {
      ok: false;
      failure: AgentFailure;
    };
