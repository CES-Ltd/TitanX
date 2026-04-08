// src/process/team/types.ts
//
// Re-export shared types from @/common so existing process-side imports
// continue to work. Renderer code should import from @/common/types/teamTypes.
export type {
  TeammateRole,
  TeammateStatus,
  WorkspaceMode,
  TeamAgent,
  TTeam,
  ITeamAgentSpawnedEvent,
  ITeamAgentStatusEvent,
  ITeamMessageEvent,
} from '@/common/types/teamTypes';

// Re-export TeamTask from common so process-side imports continue working
export type { TeamTask } from '@/common/types/teamTypes';

// ---------- Process-only types (not needed by renderer) ----------

/**
 * An inter-agent mailbox message for asynchronous communication
 * between teammates inside a team.
 */
export type MailboxMessage = {
  id: string;
  teamId: string;
  toAgentId: string;
  fromAgentId: string;
  type: 'message' | 'idle_notification' | 'shutdown_request';
  content: string;
  summary?: string;
  read: boolean;
  createdAt: number;
};

/**
 * Payload sent by an agent when it becomes idle, carrying the
 * reason and an optional summary of completed work.
 */
export type IdleNotification = {
  type: 'idle_notification';
  idleReason: 'available' | 'interrupted' | 'failed';
  summary: string;
  completedTaskId?: string;
  failureReason?: string;
};

/** Platform capability flags used by the adapter layer */
export type PlatformCapability = {
  supportsToolUse: boolean;
  supportsStreaming: boolean;
};

/**
 * Discriminated union of all structured actions an agent can emit.
 * Replaces the old `AssignTask` type.
 */
export type ParsedAction =
  | { type: 'send_message'; to: string; content: string; summary?: string }
  | { type: 'task_create'; subject: string; description?: string; owner?: string }
  | { type: 'task_update'; taskId: string; status?: string; owner?: string }
  | { type: 'spawn_agent'; agentName: string; agentType?: string; role?: string }
  | { type: 'idle_notification'; reason: string; summary: string; completedTaskId?: string }
  | { type: 'plain_response'; content: string }
  | { type: 'write_plan'; title: string; steps: string[] }
  | { type: 'reflect'; planId: string; reflection: string; score: number }
  | { type: 'trigger_workflow'; workflowId: string; inputs: Record<string, unknown> };
