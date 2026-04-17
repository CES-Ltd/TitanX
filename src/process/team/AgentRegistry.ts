/**
 * @license Apache-2.0
 * AgentRegistry — single source of truth for the team's in-memory agent list.
 *
 * Extracted from TeammateManager (Phase 3.2) so that the state surface
 * (agents[], ownedConversationIds Set, renamedAgents Map) and its mutation
 * helpers live in one cohesive, unit-testable unit. The registry is
 * *purely* state:
 *   - no event publishing
 *   - no activity logging
 *   - no DB persistence
 *
 * Callers (TeammateManager) handle side effects after mutating the registry,
 * so the registry can be tested without any DB / IPC / timer fakes.
 *
 * Immutable-update discipline: every mutation returns a fresh array so
 * external consumers that snapshot via list()/snapshot() keep a stable
 * reference to the previous generation until they re-read.
 */

import type { TeamAgent, TeammateStatus } from './types';

export class AgentRegistry {
  private agents: TeamAgent[];
  /** O(1) lookup set of conversationIds owned by this team — for IPC event filtering. */
  private readonly ownedConversationIds = new Set<string>();
  /** slotId → original agentName before first rename, for "formerly: X" prompt hints. */
  private readonly renamedAgents = new Map<string, string>();

  constructor(initial: readonly TeamAgent[] = []) {
    this.agents = [...initial];
    for (const a of initial) {
      if (a.conversationId) this.ownedConversationIds.add(a.conversationId);
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /** Readonly snapshot — caller must not mutate. */
  list(): readonly TeamAgent[] {
    return this.agents;
  }

  /** Mutable copy — for external APIs that need a non-readonly type. */
  snapshot(): TeamAgent[] {
    return [...this.agents];
  }

  findBySlotId(slotId: string): TeamAgent | undefined {
    return this.agents.find((a) => a.slotId === slotId);
  }

  findByConversationId(conversationId: string): TeamAgent | undefined {
    return this.agents.find((a) => a.conversationId === conversationId);
  }

  findByRole(role: TeamAgent['role']): TeamAgent | undefined {
    return this.agents.find((a) => a.role === role);
  }

  filterByRole(role: TeamAgent['role']): TeamAgent[] {
    return this.agents.filter((a) => a.role === role);
  }

  /** All agents NOT in the given role — convenience for "all non-lead". */
  filterNotRole(role: TeamAgent['role']): TeamAgent[] {
    return this.agents.filter((a) => a.role !== role);
  }

  ownsConversation(conversationId: string): boolean {
    return this.ownedConversationIds.has(conversationId);
  }

  /** The original name before the first rename, or undefined if never renamed. */
  getOriginalName(slotId: string): string | undefined {
    return this.renamedAgents.get(slotId);
  }

  /**
   * Readonly view of the renamed-agents map, keyed by slotId → original name.
   * Prompt builders iterate this per-teammate to show "formerly: X" hints;
   * returning the underlying map (as readonly) avoids copying on every turn.
   */
  renamedMap(): ReadonlyMap<string, string> {
    return this.renamedAgents;
  }

  /**
   * Resolve an agent reference (slotId or agentName) to a canonical slotId.
   * Tries exact slotId match first, then normalized agentName match.
   */
  resolveSlotId(nameOrSlotId: string): string | undefined {
    const bySlot = this.agents.find((a) => a.slotId === nameOrSlotId);
    if (bySlot) return bySlot.slotId;
    const needle = AgentRegistry.normalize(nameOrSlotId);
    const byName = this.agents.find((a) => AgentRegistry.normalize(a.agentName) === needle);
    return byName?.slotId;
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  /** Add an agent. No-op if slotId already exists. */
  add(agent: TeamAgent): void {
    if (this.agents.some((a) => a.slotId === agent.slotId)) return;
    this.agents = [...this.agents, agent];
    if (agent.conversationId) this.ownedConversationIds.add(agent.conversationId);
  }

  /**
   * Remove an agent by slotId. Returns the removed agent (so callers can
   * reference its conversationId / agentName after removal), or undefined
   * if no such agent exists.
   */
  remove(slotId: string): TeamAgent | undefined {
    const agent = this.agents.find((a) => a.slotId === slotId);
    if (!agent) return undefined;
    this.agents = this.agents.filter((a) => a.slotId !== slotId);
    if (agent.conversationId) this.ownedConversationIds.delete(agent.conversationId);
    return agent;
  }

  /**
   * Update an agent's status. Returns the *prior* agent snapshot (before the
   * status change) so the caller can diff / log, or undefined if not found.
   */
  setStatus(slotId: string, status: TeammateStatus): TeamAgent | undefined {
    const prior = this.agents.find((a) => a.slotId === slotId);
    if (!prior) return undefined;
    this.agents = this.agents.map((a) => (a.slotId === slotId ? { ...a, status } : a));
    return prior;
  }

  /**
   * Rename an agent. Throws on empty name, missing agent, or duplicate name
   * (matched case-insensitively, ignoring surrounding whitespace/quotes).
   * Returns the old name for the caller to use in events / audit logs.
   *
   * The first rename is recorded in renamedAgents so subsequent callers can
   * look up the *original* name via getOriginalName(); further renames do
   * not overwrite it.
   */
  rename(slotId: string, newName: string): { oldName: string; newName: string } {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Agent name cannot be empty');

    const agent = this.agents.find((a) => a.slotId === slotId);
    if (!agent) throw new Error(`Agent "${slotId}" not found`);

    const needle = AgentRegistry.normalize(trimmed);
    const duplicate = this.agents.find((a) => a.slotId !== slotId && AgentRegistry.normalize(a.agentName) === needle);
    if (duplicate) throw new Error(`Agent name "${trimmed}" is already taken by ${duplicate.slotId}`);

    const oldName = agent.agentName;
    if (!this.renamedAgents.has(slotId)) {
      this.renamedAgents.set(slotId, oldName);
    }
    this.agents = this.agents.map((a) => (a.slotId === slotId ? { ...a, agentName: trimmed } : a));
    return { oldName, newName: trimmed };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Normalize a string for fuzzy matching: trim, collapse whitespace,
   * strip invisible/zero-width chars and curly/straight quotes, lowercase.
   * Public-static so tests and external callers can reuse the same rules.
   */
  static normalize(s: string): string {
    return s
      .trim()
      .replace(/\u00a0|\u200b|\u200c|\u200d|\ufeff/g, ' ')
      .replace(/[\u201c\u201d\u201e\u2018\u2019"']/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }
}
