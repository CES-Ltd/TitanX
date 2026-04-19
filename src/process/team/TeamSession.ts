// src/process/team/TeamSession.ts
import { EventEmitter } from 'events';
import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { IWorkerTaskManager } from '@process/task/IWorkerTaskManager';
import { addMessage } from '@process/utils/message';
import type { ITeamRepository } from './repository/ITeamRepository';
import type { TTeam, TeamAgent } from './types';
import { Mailbox } from './Mailbox';
import { TaskManager } from './TaskManager';
import { TeammateManager } from './TeammateManager';
import { TeamMcpServer, type StdioMcpConfig } from './TeamMcpServer';
import { getDatabase } from '@process/services/database';
import { revokeExpiredSessionTokens } from '@process/services/policyEnforcement';
import { revokeExpiredTokens } from '@process/services/credentialAccess';
import { TEAM_CONFIG } from './config';

type SpawnAgentFn = (agentName: string, agentType?: string) => Promise<TeamAgent>;

/**
 * Thin coordinator that owns Mailbox, TaskManager, TeammateManager, and MCP server.
 * All agent orchestration is delegated to TeammateManager.
 * The MCP server provides team coordination tools to ACP agents.
 */
export class TeamSession extends EventEmitter {
  readonly teamId: string;
  private readonly team: TTeam;
  private readonly repo: ITeamRepository;
  private readonly mailbox: Mailbox;
  private readonly taskManager: TaskManager;
  private readonly teammateManager: TeammateManager;
  private readonly mcpServer: TeamMcpServer;
  private mcpStdioConfig: StdioMcpConfig | null = null;
  /** Interval handle for periodic expired token cleanup */
  private tokenCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(team: TTeam, repo: ITeamRepository, workerTaskManager: IWorkerTaskManager, spawnAgent?: SpawnAgentFn) {
    super();
    this.team = team;
    this.teamId = team.id;
    this.repo = repo;
    this.mailbox = new Mailbox(repo);
    this.taskManager = new TaskManager(repo);
    this.teammateManager = new TeammateManager({
      teamId: team.id,
      agents: team.agents,
      mailbox: this.mailbox,
      taskManager: this.taskManager,
      workerTaskManager,
      spawnAgent,
    });

    // Create MCP server for team coordination tools
    this.mcpServer = new TeamMcpServer({
      teamId: team.id,
      getAgents: () => this.teammateManager.getAgents(),
      mailbox: this.mailbox,
      taskManager: this.taskManager,
      spawnAgent,
      renameAgent: (slotId: string, newName: string) => {
        this.teammateManager.renameAgent(slotId, newName);
        void this.repo.update(team.id, { agents: this.teammateManager.getAgents(), updatedAt: Date.now() });
      },
      removeAgent: (slotId: string) => {
        this.teammateManager.removeAgent(slotId);
        void this.repo.update(team.id, { agents: this.teammateManager.getAgents(), updatedAt: Date.now() });
      },
      wakeAgent: (slotId: string) => this.teammateManager.wake(slotId),
    });
  }

  /**
   * Start the MCP server and return its stdio config.
   * Must be called before sendMessage to ensure agents have access to team tools.
   */
  async startMcpServer(): Promise<StdioMcpConfig> {
    if (!this.mcpStdioConfig) {
      this.mcpStdioConfig = await this.mcpServer.start();
      this.teammateManager.setHasMcpTools(true);

      // Start periodic cleanup of expired tokens (every 60s)
      if (!this.tokenCleanupInterval) {
        this.tokenCleanupInterval = setInterval(() => {
          void (async () => {
            try {
              const db = await getDatabase();
              const driver = db.getDriver();
              const sessionRevoked = revokeExpiredSessionTokens(driver);
              const credentialRevoked = revokeExpiredTokens(driver);
              if (sessionRevoked > 0 || credentialRevoked > 0) {
                console.log(
                  `[TokenCleanup] Revoked ${sessionRevoked} session + ${credentialRevoked} credential expired tokens`
                );
              }
            } catch {
              // Non-critical cleanup
            }
          })();
        }, TEAM_CONFIG.TOKEN_CLEANUP_INTERVAL_MS);
      }
    }
    return this.mcpStdioConfig;
  }

  /** Get the MCP stdio config, optionally tagged with a specific agent's slotId */
  getStdioConfig(agentSlotId?: string): StdioMcpConfig | null {
    if (!this.mcpStdioConfig) return null;
    if (!agentSlotId) return this.mcpStdioConfig;
    // Return a copy with the agent's slotId in env
    return this.mcpServer.getStdioConfig(agentSlotId);
  }

  /**
   * Send a user message to the team.
   * Ensures MCP server is started, then writes to the lead agent's mailbox and wakes the lead.
   */
  async sendMessage(content: string): Promise<void> {
    // Ensure MCP server is running before waking agents
    await this.startMcpServer();

    const leadSlotId = this.team.leadAgentId;
    const leadAgent = this.teammateManager.getAgents().find((a) => a.slotId === leadSlotId);

    await this.mailbox.write({
      teamId: this.teamId,
      toAgentId: leadSlotId,
      fromAgentId: 'user',
      content,
    });

    // Persist user message in lead's conversation so it appears as a user bubble in the chat UI
    if (leadAgent?.conversationId) {
      const msgId = crypto.randomUUID();
      const userMessage: TMessage = {
        id: msgId,
        msg_id: msgId,
        type: 'text',
        position: 'right',
        conversation_id: leadAgent.conversationId,
        content: { content },
        createdAt: Date.now(),
      };
      addMessage(leadAgent.conversationId, userMessage);
      ipcBridge.conversation.responseStream.emit({
        type: 'user_content',
        conversation_id: leadAgent.conversationId,
        msg_id: msgId,
        data: content,
      });
    }

    await this.teammateManager.wake(leadSlotId);
  }

  /**
   * Send a user message directly to a specific agent (by slotId), bypassing the lead.
   * Ensures MCP server is running, writes to agent's mailbox, persists user bubble, then wakes the agent.
   */
  async sendMessageToAgent(slotId: string, content: string): Promise<void> {
    await this.startMcpServer();

    await this.mailbox.write({
      teamId: this.teamId,
      toAgentId: slotId,
      fromAgentId: 'user',
      content,
    });

    const agent = this.teammateManager.getAgents().find((a) => a.slotId === slotId);
    // v2.1.2 fix: farm-backed agents use a synthetic farm-<uuid> conversationId
    // that has no row in conversations / chat.history, so addMessage +
    // responseStream.emit would both log noise / no-op. Wake the slot
    // directly — the mailbox carries the user's message to the farm
    // adapter via dispatchFarmTurn.
    if (agent?.conversationId && agent.backend !== 'farm') {
      const msgId = crypto.randomUUID();
      const userMessage: TMessage = {
        id: msgId,
        msg_id: msgId,
        type: 'text',
        position: 'right',
        conversation_id: agent.conversationId,
        content: { content },
        createdAt: Date.now(),
      };
      addMessage(agent.conversationId, userMessage);
      ipcBridge.conversation.responseStream.emit({
        type: 'user_content',
        conversation_id: agent.conversationId,
        msg_id: msgId,
        data: content,
      });
    }

    await this.teammateManager.wake(slotId);
  }

  /** Rename an agent and persist to DB */
  renameAgent(slotId: string, newName: string): void {
    this.teammateManager.renameAgent(slotId, newName);
    void this.repo.update(this.teamId, { agents: this.teammateManager.getAgents(), updatedAt: Date.now() });
  }

  /** Add a new agent to the team at runtime */
  addAgent(agent: TeamAgent): void {
    this.teammateManager.addAgent(agent);
  }

  /** Remove an agent from the team at runtime and clean up its state */
  removeAgent(slotId: string): void {
    this.teammateManager.removeAgent(slotId);
  }

  /** Get current agent states */
  getAgents(): TeamAgent[] {
    return this.teammateManager.getAgents();
  }

  /** Get the task manager for direct task queries */
  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  /** Get the mailbox for writing system messages */
  getMailbox(): Mailbox {
    return this.mailbox;
  }

  /** Wake an agent by slotId */
  async wakeAgent(slotId: string): Promise<void> {
    return this.teammateManager.wake(slotId);
  }

  /**
   * Transition all 'pending' agents to 'idle'.
   * Called after session initialization so agents don't stay stuck in pending state.
   */
  initializeAgentStatuses(): void {
    for (const agent of this.teammateManager.getAgents()) {
      if (agent.status === 'pending') {
        this.teammateManager.setStatus(agent.slotId, 'idle');
      }
    }
  }

  /** Clean up all IPC listeners, MCP server, and EventEmitter handlers */
  async dispose(): Promise<void> {
    // Stop token cleanup scheduler
    if (this.tokenCleanupInterval) {
      clearInterval(this.tokenCleanupInterval);
      this.tokenCleanupInterval = null;
    }
    this.teammateManager.setHasMcpTools(false);
    this.teammateManager.dispose();
    await this.mcpServer.stop();
    this.mcpStdioConfig = null;
    this.removeAllListeners();
  }
}
