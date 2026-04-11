// src/process/team/TeamMcpServer.ts
//
// Lightweight MCP server that exposes team coordination tools to ACP agents.
// Runs as a TCP server in the Electron main process; a stdio MCP script
// (scripts/team-mcp-stdio.mjs) bridges Claude CLI <-> TCP.
//
// Each TeamSession owns one TeamMcpServer instance. The stdio config is
// injected into every agent's ACP session via `session/new { mcpServers }`.

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Mailbox } from './Mailbox';
import type { TaskManager } from './TaskManager';
import type { TeamAgent } from './types';
import { getDatabase } from '@process/services/database';
import * as sprintService from '@process/services/sprintTasks';
import * as activityLogService from '@process/services/activityLog';
import * as policyService from '@process/services/policyEnforcement';
import { startSpan, getCounter, getHistogram } from '@process/services/telemetry';
import * as tracingService from '@process/services/tracing';
import { isFeatureEnabled } from '@process/services/securityFeatures';

type SpawnAgentFn = (agentName: string, agentType?: string) => Promise<TeamAgent>;

type TeamMcpServerParams = {
  teamId: string;
  getAgents: () => TeamAgent[];
  mailbox: Mailbox;
  taskManager: TaskManager;
  spawnAgent?: SpawnAgentFn;
  renameAgent?: (slotId: string, newName: string) => void;
  removeAgent?: (slotId: string) => void;
  wakeAgent: (slotId: string) => Promise<void>;
};

export type StdioMcpConfig = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

// ── TCP message helpers ───────────────────────────────────────────────────────

function writeTcpMessage(socket: net.Socket, data: unknown): void {
  const json = JSON.stringify(data);
  const body = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([header, body]));
}

function createTcpMessageReader(onMessage: (msg: unknown) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);

  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const bodyLen = buffer.readUInt32BE(0);
      if (buffer.length < 4 + bodyLen) break;

      const jsonStr = buffer.subarray(4, 4 + bodyLen).toString('utf-8');
      buffer = buffer.subarray(4 + bodyLen);

      try {
        const msg = JSON.parse(jsonStr);
        onMessage(msg);
      } catch {
        // Malformed JSON — skip
      }
    }
  };
}

/**
 * Resolve the path to the bundled team MCP stdio script.
 * In packaged builds it lives inside app.asar.unpacked; in dev it's in out/main/.
 */
function resolveTeamMcpScript(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    if (app.isPackaged) {
      // asarUnpack extracts it next to the asar: .../app.asar.unpacked/out/main/builtin-mcp-team.mjs
      return path.join(app.getAppPath() + '.unpacked', 'out', 'main', 'builtin-mcp-team.mjs');
    }
    return path.join(app.getAppPath(), 'out', 'main', 'builtin-mcp-team.mjs');
  } catch {
    // Fallback for CLI mode (no Electron)
    return path.resolve(__dirname, '..', '..', '..', 'out', 'main', 'builtin-mcp-team.mjs');
  }
}

/**
 * MCP server that provides team coordination tools to ACP agents.
 * Uses TCP transport with a stdio MCP script bridge.
 */
export class TeamMcpServer {
  private readonly params: TeamMcpServerParams;
  private tcpServer: net.Server | null = null;
  private _port = 0;
  /** One-time random token used to authenticate TCP connections from the stdio bridge */
  private readonly authToken = crypto.randomUUID();

  constructor(params: TeamMcpServerParams) {
    this.params = params;
  }

  /** Start the TCP server and return the stdio config for injection into ACP sessions */
  async start(): Promise<StdioMcpConfig> {
    this.tcpServer = net.createServer((socket) => {
      console.log(`[TeamMcpServer] TCP connection received from ${socket.remoteAddress}:${socket.remotePort}`);
      this.handleTcpConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.tcpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.tcpServer!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        resolve();
      });
      this.tcpServer!.once('error', reject);
    });

    console.log(`[TeamMcpServer] Team ${this.params.teamId} TCP server started on port ${this._port}`);
    return this.getStdioConfig();
  }

  /**
   * Get the stdio MCP server configuration to inject into session/new.
   * @param agentSlotId - When provided, the stdio script will attach this
   *   slot ID to every TCP request so the server knows who is calling.
   */
  getStdioConfig(agentSlotId?: string): StdioMcpConfig {
    const scriptPath = resolveTeamMcpScript();

    const env: StdioMcpConfig['env'] = [
      { name: 'TEAM_MCP_PORT', value: String(this._port) },
      { name: 'TEAM_MCP_TOKEN', value: this.authToken },
    ];
    if (agentSlotId) {
      env.push({ name: 'TEAM_AGENT_SLOT_ID', value: agentSlotId });
    }

    return {
      name: `aionui-team-${this.params.teamId}`,
      command: 'node',
      args: [scriptPath],
      env,
    };
  }

  /** Stop the TCP server */
  async stop(): Promise<void> {
    if (this.tcpServer) {
      await new Promise<void>((resolve) => {
        this.tcpServer!.close(() => {
          console.log(`[TeamMcpServer] Team ${this.params.teamId} TCP server stopped`);
          this.tcpServer = null;
          resolve();
        });
      });
    }
    this._port = 0;
  }

  /** Get the port the server is listening on */
  getPort(): number {
    return this._port;
  }

  /** Normalize a string for fuzzy matching: trim, collapse whitespace, strip quotes */
  private static normalize(s: string): string {
    return s
      .trim()
      .replace(/\u00a0|\u200b|\u200c|\u200d|\ufeff/g, ' ')
      .replace(/[\u201c\u201d\u201e\u2018\u2019"']/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private resolveSlotId(nameOrSlotId: string): string | undefined {
    const agents = this.params.getAgents();
    const bySlot = agents.find((a) => a.slotId === nameOrSlotId);
    if (bySlot) return bySlot.slotId;
    const needle = TeamMcpServer.normalize(nameOrSlotId);
    const byName = agents.find((a) => TeamMcpServer.normalize(a.agentName) === needle);
    return byName?.slotId;
  }

  // ── TCP connection handler ──────────────────────────────────────────────────

  private handleTcpConnection(socket: net.Socket): void {
    const reader = createTcpMessageReader(async (msg) => {
      const request = msg as {
        tool?: string;
        args?: Record<string, unknown>;
        from_slot_id?: string;
        auth_token?: string;
      };

      // Reject requests that do not carry the correct auth token
      if (request.auth_token !== this.authToken) {
        writeTcpMessage(socket, { error: 'Unauthorized' });
        socket.end();
        return;
      }

      const toolName = request.tool ?? '';
      const args = request.args ?? {};
      const fromSlotId = request.from_slot_id;

      try {
        const result = await this.handleToolCall(toolName, args, fromSlotId);
        writeTcpMessage(socket, { result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeTcpMessage(socket, { error: errMsg });
      }
      socket.end();
    });

    socket.on('data', reader);
    socket.on('error', () => {
      // Connection errors are expected (e.g., client disconnect)
    });
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────

  private readonly rateLimitMap = new Map<string, { count: number; windowStart: number }>();
  private static readonly RATE_LIMIT_MAX = 30; // max calls per window
  private static readonly RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window

  private checkRateLimit(slotId: string): void {
    const now = Date.now();
    const entry = this.rateLimitMap.get(slotId);

    if (!entry || now - entry.windowStart > TeamMcpServer.RATE_LIMIT_WINDOW_MS) {
      // New window
      this.rateLimitMap.set(slotId, { count: 1, windowStart: now });
      return;
    }

    entry.count++;
    if (entry.count > TeamMcpServer.RATE_LIMIT_MAX) {
      console.warn(
        `[Security] Rate limit exceeded for agent ${slotId}: ${entry.count} calls in ${TeamMcpServer.RATE_LIMIT_WINDOW_MS}ms`
      );
      throw new Error(
        `Rate limit exceeded: max ${TeamMcpServer.RATE_LIMIT_MAX} tool calls per minute. Please slow down.`
      );
    }
  }

  // ── Tool dispatch ───────────────────────────────────────────────────────────

  private async handleToolCall(toolName: string, args: Record<string, unknown>, fromSlotId?: string): Promise<string> {
    const span = startSpan('titanx.mcp', 'mcp.tool_call', {
      'mcp.tool_name': toolName,
      'mcp.agent_slot_id': fromSlotId ?? 'unknown',
      'mcp.team_id': this.params.teamId,
    });
    const callStart = Date.now();

    // Create trace run for this tool call (LangSmith-compatible)
    let traceHandle: ReturnType<typeof tracingService.startRun> | null = null;
    try {
      const db = await getDatabase();
      const driver = db.getDriver();
      if (isFeatureEnabled(driver, 'trace_system')) {
        traceHandle = tracingService.startRun(driver, `mcp:${toolName}`, 'tool', {
          agentSlotId: fromSlotId,
          teamId: this.params.teamId,
        });
      }
    } catch {
      /* non-critical */
    }

    try {
      const result = await this._handleToolCallInner(toolName, args, fromSlotId);
      traceHandle?.end({ result: result.slice(0, 500) });
      return result;
    } catch (err) {
      span.setStatus('error', err instanceof Error ? err.message : String(err));
      traceHandle?.end(undefined, err instanceof Error ? err.message : String(err));
      getCounter('titanx.mcp', 'titanx.mcp.tool_calls_error', 'Failed tool calls').add(1, {
        tool_name: toolName,
        agent_slot_id: fromSlotId ?? 'unknown',
      });
      throw err;
    } finally {
      span.end();
      const duration = Date.now() - callStart;
      getHistogram('titanx.mcp', 'titanx.mcp.tool_call_duration_ms', 'Tool call duration').record(duration, {
        tool_name: toolName,
      });
      getCounter('titanx.mcp', 'titanx.mcp.tool_calls', 'Total tool calls').add(1, {
        tool_name: toolName,
        agent_slot_id: fromSlotId ?? 'unknown',
      });
    }
  }

  private async _handleToolCallInner(
    toolName: string,
    args: Record<string, unknown>,
    fromSlotId?: string
  ): Promise<string> {
    // Rate limit check per agent
    if (fromSlotId) {
      this.checkRateLimit(fromSlotId);
    }

    // Runtime IAM policy enforcement — evaluate before dispatch
    if (fromSlotId) {
      try {
        const db = await getDatabase();
        const driver = db.getDriver();
        const agent = this.params.getAgents().find((a) => a.slotId === fromSlotId);
        const decision = policyService.evaluateToolAccess(
          driver,
          fromSlotId,
          agent?.agentGalleryId,
          toolName,
          this.params.teamId
        );
        policyService.logPolicyDecision(driver, decision, this.params.teamId);
        if (!decision.allowed) {
          throw new Error(`Policy denied: ${decision.reason}`);
        }
        // Audit log: tool call accepted
        activityLogService.logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'agent',
          actorId: fromSlotId,
          action: 'agent.tool_call',
          entityType: 'mcp_tool',
          entityId: toolName,
          agentId: fromSlotId,
          details: {
            toolName,
            teamId: this.params.teamId,
            agentName: agent?.agentName,
            argsKeys: Object.keys(args),
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Policy denied:')) {
          throw err;
        }
        // Non-critical: if policy check fails due to DB issues, log and continue
        console.warn('[TeamMcpServer] Policy check error (non-blocking):', err);
      }
    }

    switch (toolName) {
      case 'team_send_message':
        return this.handleSendMessage(args, fromSlotId);
      case 'team_spawn_agent': {
        const agents = this.params.getAgents();
        const caller = fromSlotId ? agents.find((a) => a.slotId === fromSlotId) : undefined;
        if (caller && caller.role !== 'lead') {
          throw new Error(
            'Only the team lead can spawn new agents. Send a message to the lead via team_send_message and ask them to create the agent you need.'
          );
        }
        return this.handleSpawnAgent(args, fromSlotId);
      }
      case 'team_task_create':
        return this.handleTaskCreate(args);
      case 'team_task_update':
        return this.handleTaskUpdate(args);
      case 'team_task_list':
        return this.handleTaskList();
      case 'team_members':
        return this.handleTeamMembers();
      case 'team_rename_agent':
        return this.handleRenameAgent(args);
      case 'team_shutdown_agent':
        return this.handleShutdownAgent(args, fromSlotId);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  // ── Tool handlers (logic preserved from original registerTools) ─────────────

  private async handleSendMessage(args: Record<string, unknown>, callerSlotId?: string): Promise<string> {
    const { teamId, getAgents, mailbox, wakeAgent } = this.params;
    const to = String(args.to ?? '');
    const message = String(args.message ?? '');
    const summary = args.summary ? String(args.summary) : undefined;

    const agents = getAgents();
    // Use actual caller identity when available, fall back to lead
    const fromAgent =
      (callerSlotId && agents.find((a) => a.slotId === callerSlotId)) ??
      agents.find((a) => a.role === 'lead') ??
      agents[0];
    const fromSlotId = fromAgent?.slotId ?? 'unknown';

    if (to === '*') {
      const recipients: string[] = [];
      await Promise.all(
        agents
          .filter((agent) => agent.slotId !== fromSlotId)
          .map((agent) =>
            mailbox
              .write({
                teamId,
                toAgentId: agent.slotId,
                fromAgentId: fromSlotId,
                content: message,
                summary,
              })
              .then(() => {
                recipients.push(agent.agentName);
                void wakeAgent(agent.slotId);
              })
          )
      );
      return `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`;
    }

    const targetSlotId = this.resolveSlotId(to);
    if (!targetSlotId) {
      throw new Error(`Teammate "${to}" not found. Available: ${agents.map((a) => a.agentName).join(', ')}`);
    }

    // Intercept shutdown responses from members
    const trimmedMessage = message.trim();
    const isShutdownApproved = trimmedMessage === 'shutdown_approved';
    const isShutdownRejected = trimmedMessage.startsWith('shutdown_rejected');

    if (isShutdownApproved || isShutdownRejected) {
      const senderAgent = agents.find((a) => a.slotId === fromSlotId);
      const memberName = senderAgent?.agentName ?? fromSlotId;
      const leadAgent = agents.find((a) => a.role === 'lead');
      const leadSlotId = leadAgent?.slotId;

      if (isShutdownApproved && this.params.removeAgent) {
        this.params.removeAgent(fromSlotId);
        if (leadSlotId) {
          await mailbox.write({
            teamId,
            toAgentId: leadSlotId,
            fromAgentId: fromSlotId,
            content: `${memberName} has shut down and been removed from the team.`,
          });
          void wakeAgent(leadSlotId);
        }
        return 'Shutdown confirmed. You have been removed from the team.';
      } else if (isShutdownRejected) {
        const reason = trimmedMessage.replace(/^shutdown_rejected[:\s]*/i, '').trim() || 'No reason given.';
        if (leadSlotId) {
          await mailbox.write({
            teamId,
            toAgentId: leadSlotId,
            fromAgentId: fromSlotId,
            content: `${memberName} refused to shut down. Reason: ${reason}`,
          });
          void wakeAgent(leadSlotId);
        }
        return 'Refusal sent to the lead.';
      }
    }

    await mailbox.write({
      teamId,
      toAgentId: targetSlotId,
      fromAgentId: fromSlotId,
      content: message,
      summary,
    });
    void wakeAgent(targetSlotId);

    return `Message sent to ${to}'s inbox. They will process it shortly.`;
  }

  private async handleSpawnAgent(args: Record<string, unknown>, callerSlotId?: string): Promise<string> {
    const { teamId, getAgents, mailbox, spawnAgent, wakeAgent } = this.params;
    const name = String(args.name ?? '');
    const agentType = args.agent_type ? String(args.agent_type) : undefined;
    // Team mode whitelist: only verified backends that support MCP tool injection
    const TEAM_ALLOWED = new Set(['claude', 'codex']);
    if (agentType && !TEAM_ALLOWED.has(agentType)) {
      throw new Error(
        `Agent type "${agentType}" is not supported in team mode. Supported: ${[...TEAM_ALLOWED].join(', ')}.`
      );
    }

    if (!spawnAgent) {
      throw new Error('Agent spawning is not available for this team.');
    }

    const newAgent = await spawnAgent(name, agentType);
    const agents = getAgents();
    const fromAgent =
      (callerSlotId && agents.find((a) => a.slotId === callerSlotId)) ??
      agents.find((a) => a.role === 'lead') ??
      agents[0];
    const fromSlotId = fromAgent?.slotId ?? 'unknown';
    await mailbox.write({
      teamId,
      toAgentId: newAgent.slotId,
      fromAgentId: fromSlotId,
      content: `You have been spawned as "${name}" and added to the team. Check the task board and await instructions.`,
    });
    void wakeAgent(newAgent.slotId);
    return `Teammate "${name}" (${newAgent.slotId}) has been created and joined the team. You can now assign tasks and send messages to them.`;
  }

  private async handleTaskCreate(args: Record<string, unknown>): Promise<string> {
    const { teamId, taskManager } = this.params;
    const subject = String(args.subject ?? '');
    const description = args.description ? String(args.description) : undefined;
    const owner = args.owner ? String(args.owner) : undefined;

    // taskManager.create() handles both team_tasks AND sprint_tasks creation
    // with proper teamTaskId linking and audit logging — no duplicate needed here.
    const task = await taskManager.create({ teamId, subject, description, owner });
    console.log(`[TeamMcpServer] team_task_create: "${subject}" → task ${task.id} + sprint task created via TaskManager`);

    // Auto-wake the assigned agent so they discover the new task immediately (no polling)
    if (owner) {
      const agents = this.params.getAgents();
      const assignee = agents.find((a) => a.agentName.toLowerCase() === owner.toLowerCase());
      if (assignee) {
        console.log(`[TeamMcpServer] Auto-waking ${assignee.agentName} for new task: "${subject}"`);
        void this.params.wakeAgent(assignee.slotId);
      }
    }

    return `Task created: [${task.id.slice(0, 8)}] "${subject}"${owner ? ` (assigned to ${owner})` : ''}`;
  }

  private async handleTaskUpdate(args: Record<string, unknown>): Promise<string> {
    const { taskManager } = this.params;
    const taskId = String(args.task_id ?? '');
    const rawStatus = args.status ? String(args.status) : undefined;
    const owner = args.owner ? String(args.owner) : undefined;

    const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
    const status =
      rawStatus && VALID_STATUSES.has(rawStatus)
        ? (rawStatus as 'pending' | 'in_progress' | 'completed' | 'deleted')
        : undefined;
    if (rawStatus && !status) {
      throw new Error(`Invalid task status "${rawStatus}". Must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }

    await taskManager.update(taskId, { status, owner });
    if (status === 'completed') {
      await taskManager.checkUnblocks(taskId);
    }

    // Sprint sync + audit logging handled centrally by TaskManager.update()

    return `Task ${taskId.slice(0, 8)} updated.${status ? ` Status: ${status}.` : ''}${owner ? ` Owner: ${owner}.` : ''}`;
  }

  private async handleTaskList(): Promise<string> {
    const { teamId, taskManager } = this.params;
    const tasks = await taskManager.list(teamId);
    if (tasks.length === 0) {
      return 'No tasks on the board yet.';
    }
    const lines = tasks.map(
      (t) => `- [${t.id.slice(0, 8)}] ${t.subject} (${t.status}${t.owner ? `, owner: ${t.owner}` : ', unassigned'})`
    );
    return `## Team Tasks\n${lines.join('\n')}`;
  }

  private async handleTeamMembers(): Promise<string> {
    const agents = this.params.getAgents();
    if (agents.length === 0) {
      return 'No team members yet.';
    }
    const lines = agents.map((a) => `- ${a.agentName} (type: ${a.agentType}, role: ${a.role}, status: ${a.status})`);
    return `## Team Members\n${lines.join('\n')}`;
  }

  private async handleShutdownAgent(args: Record<string, unknown>, callerSlotId?: string): Promise<string> {
    const { teamId, getAgents, mailbox, wakeAgent } = this.params;
    const agentRef = String(args.agent ?? '');

    const resolvedSlotId = this.resolveSlotId(agentRef);
    if (!resolvedSlotId) {
      const agents = getAgents();
      throw new Error(`Agent "${agentRef}" not found. Available: ${agents.map((a) => a.agentName).join(', ')}`);
    }
    const agents = getAgents();
    const agent = agents.find((a) => a.slotId === resolvedSlotId);
    if (agent?.role === 'lead') {
      throw new Error('Cannot shut down the team lead.');
    }

    const fromSlotId = callerSlotId ?? agents.find((a) => a.role === 'lead')?.slotId ?? 'unknown';

    await mailbox.write({
      teamId,
      toAgentId: resolvedSlotId,
      fromAgentId: fromSlotId,
      type: 'shutdown_request',
      content:
        'The team lead has requested you to shut down. Reply "shutdown_approved" to confirm, or "shutdown_rejected: <reason>" to refuse.',
    });
    void wakeAgent(resolvedSlotId);

    return `Shutdown request sent to "${agent?.agentName ?? agentRef}". Waiting for their confirmation.`;
  }

  private handleRenameAgent(args: Record<string, unknown>): string {
    const agentRef = String(args.agent ?? '');
    const newName = String(args.new_name ?? '');

    if (!this.params.renameAgent) {
      throw new Error('Agent renaming is not available for this team.');
    }

    const resolvedSlotId = this.resolveSlotId(agentRef);
    if (!resolvedSlotId) {
      const agents = this.params.getAgents();
      throw new Error(`Agent "${agentRef}" not found. Available: ${agents.map((a) => a.agentName).join(', ')}`);
    }

    const agents = this.params.getAgents();
    const oldName = agents.find((a) => a.slotId === resolvedSlotId)?.agentName ?? agentRef;

    this.params.renameAgent(resolvedSlotId, newName);
    return `Agent renamed: "${oldName}" → "${newName.trim()}"`;
  }
}
