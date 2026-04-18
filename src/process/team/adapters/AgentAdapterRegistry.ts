/**
 * @license Apache-2.0
 * AgentAdapterRegistry — the single lookup that maps an `AgentBackend`
 * to a concrete adapter factory.
 *
 * Phase A v1.9.40 ships the `'local'` adapter (thin wrapper around the
 * existing `TeammateManager.wake()` pipeline). Phase B (v1.10.0) will
 * register a `'farm'` adapter that dispatches via
 * fleetCommands.enqueueCommand → heartbeat-piggyback → slave-side
 * farmExecutor → ack. Callers never know which one they got.
 *
 * Registry is process-local. Test suites can call
 * `__resetAgentAdapterRegistry()` to unregister everything between
 * cases. Production code registers once at boot.
 */

import type { AgentBackend, IAgent } from '../ports/IAgent';

/**
 * Factory: given a slot descriptor, produce the `IAgent` that drives it.
 * Adapters encapsulate how they track per-slot state (the local adapter
 * delegates to TeammateManager; the farm adapter will track per-slot
 * jobId promises).
 */
export type AgentAdapterFactory = (descriptor: AgentDescriptor) => IAgent;

/**
 * Minimum slot info an adapter needs to produce an IAgent. Matches the
 * fields every backend can fill in from a team row; adapter-specific
 * extensions (e.g. farm binding details) are passed through opaquely on
 * the same object.
 */
export type AgentDescriptor = {
  slotId: string;
  displayName: string;
  backend: AgentBackend;
  fleetBinding?: import('../ports/IAgent').FleetBinding;
};

const registry: Map<AgentBackend, AgentAdapterFactory> = new Map();

/**
 * Register (or replace) the adapter factory for a backend. Replacing
 * is intentional — app lifecycle can rebind without a singleton reset,
 * and tests can stub the local factory to produce deterministic agents.
 */
export function registerAgentAdapter(backend: AgentBackend, factory: AgentAdapterFactory): void {
  registry.set(backend, factory);
}

/**
 * Look up the adapter factory for a backend. Throws when no factory
 * is registered — the alternative (returning a no-op) would silently
 * drop wakes, which is strictly worse than a loud startup failure
 * that tells the operator "you forgot to wire Phase B".
 */
export function getAgentAdapter(backend: AgentBackend): AgentAdapterFactory {
  const factory = registry.get(backend);
  if (!factory) {
    throw new Error(`No agent adapter registered for backend='${backend}'. Did app bootstrap complete?`);
  }
  return factory;
}

/** True if a factory is registered for this backend. Non-throwing. */
export function hasAgentAdapter(backend: AgentBackend): boolean {
  return registry.has(backend);
}

/** Reset registry — TEST ONLY. Production should not call this. */
export function __resetAgentAdapterRegistry(): void {
  registry.clear();
}
