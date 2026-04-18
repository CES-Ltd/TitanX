// src/common/types/teamTypes.ts
// Shared team types used by both main process and renderer.
// Renderer code should import from here instead of @process/team/types.

/**
 * Role of a teammate within a team.
 * - lead: Primary agent that coordinates the team
 * - queen: Authoritative swarm coordinator with drift detection (Agent OS)
 * - teammate: Worker agent that executes tasks
 */
export type TeammateRole = 'lead' | 'queen' | 'teammate';

/** Lifecycle status of a teammate agent */
export type TeammateStatus = 'pending' | 'idle' | 'active' | 'completed' | 'failed';

/** Workspace sharing strategy for the team */
export type WorkspaceMode = 'shared' | 'isolated';

/**
 * Where an agent actually runs. Phase B (v1.10.0) added 'farm' for
 * Agent Farm mode — wakes dispatch via fleet command channel instead
 * of local TeammateManager invocation.
 *
 * Absent / undefined backend means 'local' (backward-compat with
 * pre-Phase-B team rows).
 */
export type AgentBackend = 'local' | 'farm';

/**
 * For farm-backed agents: which slave device + which local template
 * to execute. toolsAllowlist is enforced slave-side.
 */
export type AgentFleetBinding = {
  deviceId: string;
  /** The agent_gallery row id on the slave (synced via config bundle). */
  remoteSlotId: string;
  /**
   * Tool allow-list the master permits this slot to invoke. Recorded
   * in every agent.execute envelope; v1.10.0 farm executor does NOT
   * execute tools (empty enforcement), so this is audit-only until
   * v1.10.x wires tool dispatch on the slave side.
   */
  toolsAllowlist: string[];
};

/** Persisted agent configuration within a team */
export type TeamAgent = {
  slotId: string;
  conversationId: string;
  role: TeammateRole;
  agentType: string;
  agentName: string;
  conversationType: string;
  status: TeammateStatus;
  cliPath?: string;
  customAgentId?: string;
  /** Agent gallery ID for IAM policy bindings and runtime enforcement */
  agentGalleryId?: string;
  /** Phase B: where this agent runs. Undefined = 'local'. */
  backend?: AgentBackend;
  /** Phase B: present only when backend='farm'. */
  fleetBinding?: AgentFleetBinding;
};

/** Persisted team record (stored in SQLite `teams` table) */
export type TTeam = {
  id: string;
  userId: string;
  name: string;
  workspace: string;
  workspaceMode: WorkspaceMode;
  leadAgentId: string;
  agents: TeamAgent[];
  createdAt: number;
  updatedAt: number;
};

/** A unit of work tracked inside a team's shared task board (shared with renderer) */
export type TeamTask = {
  id: string;
  teamId: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  /** Canonical owner — always stored as agentName (stable across restarts), never slotId */
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  metadata: Record<string, unknown>;
  /** Agent progress notes — what was done, what remains. Critical for resume after restart. */
  progressNotes?: string;
  createdAt: number;
  updatedAt: number;
};

/** IPC event pushed to renderer when agent status changes */
export type ITeamAgentStatusEvent = {
  teamId: string;
  slotId: string;
  status: TeammateStatus;
  lastMessage?: string;
};

/** IPC event pushed to renderer when a new agent is spawned at runtime */
export type ITeamAgentSpawnedEvent = {
  teamId: string;
  agent: TeamAgent;
};

/** IPC event pushed to renderer when an agent is removed from the team */
export type ITeamAgentRemovedEvent = {
  teamId: string;
  slotId: string;
};

/** IPC event pushed to renderer when an agent is renamed */
export type ITeamAgentRenamedEvent = {
  teamId: string;
  slotId: string;
  oldName: string;
  newName: string;
};

/** IPC event for streaming agent messages to renderer */
export type ITeamMessageEvent = {
  teamId: string;
  slotId: string;
  type: string;
  data: unknown;
  msg_id: string;
  conversation_id: string;
};
