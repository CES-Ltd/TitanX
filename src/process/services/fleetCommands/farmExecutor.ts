/**
 * @license Apache-2.0
 * farmExecutor — slave-side handler for `agent.execute` commands
 * (Phase B, v1.10.0).
 *
 * Master dispatches an `agent.execute` signed envelope carrying:
 *   - jobId              master's tracking id (same id lives in both
 *                        master + slave fleet_agent_jobs tables)
 *   - agentTemplateId    agent_gallery row id on this slave (distributed
 *                        via the config bundle, source='master')
 *   - messages           the chat turn to run
 *   - model?             optional override; falls back to template/provider
 *   - temperature?       optional
 *   - toolsAllowlist[]   allow-list reserved for v1.10.x; v1.10.0 does
 *                        NOT execute tool calls (pure LLM turn)
 *   - timeoutMs          master's own timeout; slave enforces a slightly
 *                        shorter Promise.race to avoid a stuck provider
 *                        hanging the command loop
 *
 * The handler:
 *   1. Validates the params shape — skipped with stable reason codes
 *      on anything malformed so the master dashboard can render
 *      "rejected: invalid_messages" instead of a vague 'failed'.
 *   2. Inserts a `fleet_agent_jobs` row with status='running' for
 *      local telemetry aggregation. This mirror is the slave-local
 *      source of truth for farm-stats buckets.
 *   3. Resolves the agent_gallery template → falls back to the first
 *      enabled provider in `model.config` if the template doesn't
 *      pin one.
 *   4. Builds a LangChain `BaseChatModel` via the shared
 *      `createChatModel()` factory (reuses the exact provider logic
 *      the deepAgent stack already ships).
 *   5. Runs a single `invoke()` wrapped in a Promise.race timeout.
 *   6. Updates the job row to completed/failed/timeout.
 *   7. Returns the HandlerOutcome with assistantText + usage so the
 *      master adapter can forward it to the waiting wake() promise.
 *
 * v1.10.0 scope (intentional non-goals, to be addressed in v1.10.x):
 *   - No tool execution (toolsAllowlist stored for audit; not enforced)
 *   - No streaming back to master (single-shot invoke; master's ack
 *     contains the final text)
 *   - No per-template provider pinning (uses slave's first enabled
 *     provider); v1.10.1 will honor template.config.provider
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getDatabase } from '@process/services/database';
import { ProcessConfig } from '@process/utils/initStorage';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { AckStatus } from './types';
import type { AcpBackend } from '@/common/types/acpTypes';

export type HandlerOutcome = {
  status: AckStatus;
  result?: Record<string, unknown>;
};

/** Envelope-body shape the master sends in `agent.execute`. */
type ExecuteParams = {
  jobId: string;
  agentTemplateId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; name?: string }>;
  model?: string;
  temperature?: number;
  toolsAllowlist?: string[];
  timeoutMs?: number;
  /**
   * v2.2.1 — master team context so the slave can mirror the team +
   * farm conversation locally. Absent when the caller is a pre-v2.2.1
   * master (in which case the slave skips the mirror and still
   * executes the turn).
   */
  teamId?: string;
  teamName?: string;
  agentSlotId?: string;
  agentName?: string;
  /**
   * v2.2.2 — operator-chosen ACP runtime (claude, opencode, codex,
   * gemini, \u2026). The slave should dispatch the turn to this ACP
   * adapter; omitted means fall back to the template's agentType.
   * v2.2.x still goes through the LangChain provider path regardless
   * — the field is stored for audit + v2.3.0 ACP dispatch.
   */
  runtimeBackend?: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;
// Small buffer under the master's timeout — the slave trips first so
// master always sees a clean 'timeout' ack rather than racing to a
// fleet_timeout on its own side (which would create two records of
// the same wedge).
const TIMEOUT_SAFETY_MARGIN_MS = 2_000;

/**
 * Best-effort type guard for the envelope payload. Unknown fields
 * pass through; only the load-bearing ones are validated.
 */
function parseParams(params: Record<string, unknown>): ExecuteParams | null {
  if (typeof params.jobId !== 'string' || params.jobId.length === 0) return null;
  if (typeof params.agentTemplateId !== 'string' || params.agentTemplateId.length === 0) return null;
  if (!Array.isArray(params.messages) || params.messages.length === 0) return null;
  const messages: ExecuteParams['messages'] = [];
  for (const m of params.messages) {
    if (typeof m !== 'object' || m === null) return null;
    const mo = m as Record<string, unknown>;
    if (mo.role !== 'user' && mo.role !== 'assistant' && mo.role !== 'system') return null;
    if (typeof mo.content !== 'string') return null;
    messages.push({
      role: mo.role,
      content: mo.content,
      name: typeof mo.name === 'string' ? mo.name : undefined,
    });
  }
  const toolsAllowlist = Array.isArray(params.toolsAllowlist)
    ? params.toolsAllowlist.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    jobId: params.jobId,
    agentTemplateId: params.agentTemplateId,
    messages,
    model: typeof params.model === 'string' ? params.model : undefined,
    temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
    toolsAllowlist,
    timeoutMs: typeof params.timeoutMs === 'number' ? params.timeoutMs : undefined,
    teamId: typeof params.teamId === 'string' ? params.teamId : undefined,
    teamName: typeof params.teamName === 'string' ? params.teamName : undefined,
    agentSlotId: typeof params.agentSlotId === 'string' ? params.agentSlotId : undefined,
    agentName: typeof params.agentName === 'string' ? params.agentName : undefined,
    runtimeBackend: typeof params.runtimeBackend === 'string' ? params.runtimeBackend : undefined,
  };
}

/**
 * v2.2.1 — mirror the master's team + farm conversation on the slave
 * so the operator can see the work happening on this device in a
 * familiar Teams UI. Idempotent: if the mirror team + conversation
 * already exist, only the message log grows.
 *
 * On failure each step is logged non-critically and the function
 * returns the best partial state it produced — we never want a
 * mirror-write error to abort the actual farm turn.
 */
function upsertSlaveMirror(
  db: ISqliteDriver,
  params: ExecuteParams,
  assistantText: string | null
): { mirroredConversationId: string | null } {
  const teamId = params.teamId;
  const teamName = params.teamName;
  const agentSlotId = params.agentSlotId;
  const agentName = params.agentName;
  if (!teamId || !teamName || !agentSlotId || !agentName) {
    return { mirroredConversationId: null };
  }
  // Team row. Keyed by master's teamId directly so a second
  // agent.execute for the same master team updates the same row.
  try {
    const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId) as { id: string } | undefined;
    if (!existing) {
      // Fresh mirror team. Workspace is empty because farm work runs
      // in the ACP runtime's own workspace context on this machine.
      // lead_agent_id is a placeholder — this team has no lead; all
      // activity is farm-driven. Mailbox/tasks tables won't be hit.
      db.prepare(
        `INSERT INTO teams (id, user_id, name, workspace, workspace_mode, lead_agent_id, agents, created_at, updated_at)
         VALUES (?, 'system_default_user', ?, '', 'shared', ?, ?, ?, ?)`
      ).run(teamId, teamName, agentSlotId, JSON.stringify([]), Date.now(), Date.now());
    } else {
      // Touch updated_at so the team floats in the slave's TeamSider.
      db.prepare('UPDATE teams SET name = ?, updated_at = ? WHERE id = ?').run(teamName, Date.now(), teamId);
    }
  } catch (e) {
    logNonCritical('fleet.farm.mirror.team', e);
  }

  // Conversation row. One conversation per farm slot inside the
  // mirror team — same grouping the master uses. ID is stable
  // (farm-mirror-<agentSlotId>) so a follow-up agent.execute hits the
  // same conversation and extends its message log.
  const conversationId = `farm-mirror-${agentSlotId}`;
  try {
    const exists = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as
      | { id: string }
      | undefined;
    if (!exists) {
      const extra = JSON.stringify({
        deviceId: 'self',
        remoteSlotId: params.agentTemplateId,
        teamId,
        agentSlotId,
        toolsAllowlist: params.toolsAllowlist ?? [],
        // v2.2.1 — signals the renderer (FarmChat) that this is a
        // slave-side mirror of a master-hired farm slot. Drives the
        // read-only SendBox rendering + "Viewing master's work" badge.
        isSlaveMirror: true,
      });
      db.prepare(
        `INSERT INTO conversations (id, user_id, name, type, extra, status, created_at, updated_at)
         VALUES (?, 'system_default_user', ?, 'farm', ?, 'finished', ?, ?)`
      ).run(conversationId, agentName, extra, Date.now(), Date.now());
    }
  } catch (e) {
    logNonCritical('fleet.farm.mirror.conversation', e);
  }

  // Update the team row's agents array to include this slot. Cheap
  // read-then-write — fleet mirror teams are small.
  try {
    const row = db.prepare('SELECT agents FROM teams WHERE id = ?').get(teamId) as { agents: string } | undefined;
    const agents = row ? (JSON.parse(row.agents) as Array<Record<string, unknown>>) : [];
    if (!agents.some((a) => a.slotId === agentSlotId)) {
      agents.push({
        slotId: agentSlotId,
        conversationId,
        role: 'teammate',
        agentType: 'farm',
        agentName,
        conversationType: 'farm',
        status: 'idle',
        backend: 'farm',
      });
      db.prepare('UPDATE teams SET agents = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(agents),
        Date.now(),
        teamId
      );
    }
  } catch (e) {
    logNonCritical('fleet.farm.mirror.agents', e);
  }

  // Persist messages. The final user prompt in the envelope is the
  // most recent master-side prompt; earlier messages are history/
  // teammates context we don't re-log. assistantText is only non-null
  // on success — failure paths write their own error bubble.
  try {
    const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      const msgId = `${params.jobId}-user`;
      db.prepare(
        `INSERT OR IGNORE INTO messages (id, conversation_id, msg_id, type, content, position, status, hidden, created_at)
         VALUES (?, ?, ?, 'text', ?, 'right', 'finished', 0, ?)`
      ).run(msgId, conversationId, msgId, JSON.stringify({ content: lastUser.content }), Date.now());
    }
    if (assistantText && assistantText.length > 0) {
      const msgId = `${params.jobId}-assistant`;
      db.prepare(
        `INSERT OR IGNORE INTO messages (id, conversation_id, msg_id, type, content, position, status, hidden, created_at)
         VALUES (?, ?, ?, 'text', ?, 'left', 'finished', 0, ?)`
      ).run(msgId, conversationId, msgId, JSON.stringify({ content: assistantText }), Date.now());
    }
  } catch (e) {
    logNonCritical('fleet.farm.mirror.messages', e);
  }

  return { mirroredConversationId: conversationId };
}

/** Minimal shape of an agent_gallery row — only fields farm needs. */
type GalleryTemplate = {
  id: string;
  name: string;
  agentType: string;
  config: Record<string, unknown>;
  allowedTools: string[];
};

function loadTemplate(db: ISqliteDriver, id: string): GalleryTemplate | null {
  const row = db
    .prepare('SELECT id, name, agent_type, config, allowed_tools FROM agent_gallery WHERE id = ?')
    .get(id) as { id: string; name: string; agent_type: string; config: string; allowed_tools: string } | undefined;
  if (!row) return null;
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.config) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    /* leave empty */
  }
  let allowedTools: string[] = [];
  try {
    const parsed = JSON.parse(row.allowed_tools) as unknown;
    if (Array.isArray(parsed)) allowedTools = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    /* leave empty */
  }
  return { id: row.id, name: row.name, agentType: row.agent_type, config, allowedTools };
}

/** Job lifecycle writes — mirror fleet_agent_jobs on the slave. */
function recordJobStart(db: ISqliteDriver, params: ExecuteParams, teamId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO fleet_agent_jobs
     (id, device_id, team_id, agent_slot_id, request_payload, status, enqueued_at, dispatched_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
  ).run(
    params.jobId,
    // device_id is THIS slave's id. A slave's own row uses its self-id
    // as a marker; the master-side mirror has the actual device id.
    // For telemetry aggregation the slave treats 'self' as its own jobs.
    'self',
    teamId,
    params.agentTemplateId,
    JSON.stringify({
      messagesCount: params.messages.length,
      model: params.model,
      temperature: params.temperature,
      toolsAllowlist: params.toolsAllowlist,
    }),
    Date.now(),
    Date.now()
  );
}

function recordJobFinish(
  db: ISqliteDriver,
  jobId: string,
  status: 'completed' | 'failed' | 'timeout',
  responsePayload: unknown,
  error?: string
): void {
  db.prepare(
    `UPDATE fleet_agent_jobs
     SET status = ?, response_payload = ?, completed_at = ?, error = ?
     WHERE id = ?`
  ).run(status, JSON.stringify(responsePayload ?? {}), Date.now(), error ?? null, jobId);
}

/** Build a TProviderWithModel from slave's ProcessConfig.model.config. */
async function resolveProvider(
  modelOverride: string | undefined
): Promise<import('@/common/config/storage').TProviderWithModel | null> {
  const providers = (await ProcessConfig.get('model.config')) as
    | Array<import('@/common/config/storage').IProvider>
    | undefined;
  if (!Array.isArray(providers) || providers.length === 0) return null;
  const enabled = providers.find((p) => p.enabled !== false);
  if (!enabled) return null;
  const useModel =
    modelOverride ?? (Array.isArray(enabled.model) && enabled.model.length > 0 ? enabled.model[0] : 'auto');
  return { ...enabled, useModel } as import('@/common/config/storage').TProviderWithModel;
}

/** Wrap a promise in a timeout that rejects with a typed sentinel. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AGENT_EXECUTE_TIMEOUT')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * v2.3.0 — ACP runtimes the farm executor can dispatch turns to via
 * the existing AcpAgent spawn path. When an operator hires a farm
 * agent with one of these backends, the slave bypasses
 * `resolveProvider` entirely — the CLI handles its own auth +
 * inference, no LLM API key required on the slave. Anything outside
 * this set still falls through to the LangChain provider path.
 */
const ACP_DISPATCH_BACKENDS: ReadonlySet<string> = new Set([
  'claude',
  'gemini',
  'qwen',
  'iflow',
  'codex',
  'codebuddy',
  'droid',
  'goose',
  'auggie',
  'kimi',
  'opencode',
  'copilot',
  'qoder',
  'vibe',
  'cursor',
  'kiro',
  'deepagents',
]);

/**
 * v2.3.0 — serialize the envelope's messages[] into a single prompt
 * the CLI can consume as one user turn. System messages become a
 * prefix; prior user/assistant pairs become a short transcript; the
 * most-recent user message is the actual request. Keeps the ACP
 * session a pure one-shot (no persistent history across envelopes).
 */
function buildAcpPrompt(messages: ExecuteParams['messages']): string {
  const systemParts: string[] = [];
  const history: string[] = [];
  let finalUser: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'system') {
      systemParts.push(m.content.trim());
      continue;
    }
    // The most recent user message is the "active" request. Anything
    // before it is transcript context.
    const isLastUser = m.role === 'user' && messages.slice(i + 1).every((later) => later.role !== 'user');
    if (isLastUser) {
      finalUser = m.content;
      continue;
    }
    const prefix = m.role === 'user' ? `[${m.name ?? 'user'}]:` : '[assistant]:';
    history.push(`${prefix} ${m.content.trim()}`);
  }

  const parts: string[] = [];
  if (systemParts.length > 0) parts.push(systemParts.join('\n\n'));
  if (history.length > 0) parts.push(`Prior conversation:\n${history.join('\n')}`);
  parts.push(finalUser ?? '(no user request supplied)');
  return parts.join('\n\n---\n\n');
}

/**
 * v2.3.1 — resolve the CLI path for the chosen backend from the
 * slave's own ACP detector. AcpConnection requires `cliPath` for
 * most backends (opencode, codex, goose, \u2026); only a handful
 * (gemini's built-in) can connect without one. The slave's
 * acpDetector already probes `which <cli>` at boot and stashes the
 * result on each DetectedAgent, so we just look it up.
 *
 * v2.3.2 — uses `await import()` instead of `require()`. The
 * bundler (esbuild/vite) rewrites path aliases for static and
 * dynamic `import()` statements, but leaves `require()` strings
 * literal, so the packaged app couldn't find the module at runtime.
 *
 * Returns `null` if the backend isn't detected. The caller surfaces
 * that as `runtime_not_detected` so the operator knows to install
 * or re-login the CLI on the slave.
 */
async function resolveCliPathForBackend(
  backend: AcpBackend
): Promise<{ cliPath?: string; detectedName?: string; acpArgs?: string[] } | null> {
  const mod = await import('@process/agent/acp/AcpDetector');
  const detected = mod.acpDetector.getDetectedAgents();
  const match = detected.find((a) => a.backend === backend);
  if (!match) return null;
  return { cliPath: match.cliPath, detectedName: match.name, acpArgs: match.acpArgs };
}

// ── v2.4.0 — persistent slave-Lead ACP sessions ───────────────────────
//
// When a team was provisioned via `team.farm_provision`, the slave
// owns a Lead conversation whose CLI session is long-lived across
// master turns. That preserves context ("remember what we said last
// turn") and avoids the 2-5s ACP connect cost per message.
//
// Cache keyed by teamId — one Lead session per mirrored team. Master
// turns for any teammate in that team drive the cached Lead.

type LeadTurnContext = {
  accumulator: string;
  resolve: (
    r: { ok: true; text: string } | { ok: false; reason: string; error: string }
  ) => void;
  finishReason: string | null;
};

type LeadSession = {
  agent: import('@process/agent/acp').AcpAgent;
  teamId: string;
  leadConversationId: string;
  backend: AcpBackend;
  tmpWorkspace: string;
  currentTurn: LeadTurnContext | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const leadSessions = new Map<string, LeadSession>();
const LEAD_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function scheduleLeadIdleTeardown(session: LeadSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void teardownLeadSession(session.teamId, 'idle_timeout');
  }, LEAD_IDLE_TIMEOUT_MS);
}

async function teardownLeadSession(teamId: string, reason: string): Promise<void> {
  const session = leadSessions.get(teamId);
  if (!session) return;
  leadSessions.delete(teamId);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await session.agent.kill();
  } catch (e) {
    logNonCritical(`fleet.farm.lead.kill:${reason}`, e);
  }
  try {
    await fs.rm(session.tmpWorkspace, { recursive: true, force: true });
  } catch (e) {
    logNonCritical(`fleet.farm.lead.cleanup:${reason}`, e);
  }
}

/**
 * Resolve the Lead conversation + its ACP backend for a team on this
 * slave. Returns null if the team wasn't provisioned through v2.4.0's
 * `team.farm_provision` path — caller falls back to the old ephemeral
 * executor in that case.
 */
async function resolveTeamLead(
  db: ISqliteDriver,
  teamId: string
): Promise<{ leadConversationId: string; backend: AcpBackend } | null> {
  const teamRow = db
    .prepare('SELECT lead_agent_id, agents FROM teams WHERE id = ?')
    .get(teamId) as { lead_agent_id: string; agents: string } | undefined;
  if (!teamRow) return null;
  let agents: Array<{ slotId: string; conversationId?: string; agentType?: string; role?: string }> = [];
  try {
    agents = JSON.parse(teamRow.agents) as typeof agents;
  } catch {
    return null;
  }
  const leadSlot = agents.find((a) => a.slotId === teamRow.lead_agent_id);
  if (!leadSlot || !leadSlot.conversationId || !leadSlot.agentType) return null;
  // Validate the conversation still exists on this slave — teams
  // row could have been written by a pre-v2.4.0 upsertSlaveMirror
  // that stamped lead_agent_id=teammateSlot without creating a Lead
  // conversation.
  const convRow = db
    .prepare('SELECT id FROM conversations WHERE id = ? AND type = ?')
    .get(leadSlot.conversationId, 'acp') as { id: string } | undefined;
  if (!convRow) return null;
  return { leadConversationId: leadSlot.conversationId, backend: leadSlot.agentType as AcpBackend };
}

/**
 * Get-or-start the Lead's ACP session. Spins up a fresh CLI process
 * scoped to the team's tmp workspace, attaches stream callbacks that
 * funnel into the session's `currentTurn` bucket (mutable across
 * turns). Cached thereafter; idle timer kills it after 30min
 * inactivity.
 */
async function getOrStartLeadSession(
  teamId: string,
  leadConversationId: string,
  backend: AcpBackend
): Promise<{ ok: true; session: LeadSession } | { ok: false; reason: string; error: string }> {
  const cached = leadSessions.get(teamId);
  if (cached) {
    scheduleLeadIdleTeardown(cached);
    return { ok: true, session: cached };
  }
  const detection = await resolveCliPathForBackend(backend);
  if (!detection) {
    return {
      ok: false,
      reason: 'runtime_not_detected',
      error: `Backend '${backend}' not detected on this device. Install the CLI and restart TitanX on the slave.`,
    };
  }
  const tmpWorkspace = path.join(os.tmpdir(), `titanx-farm-lead-${teamId}`);
  try {
    await fs.mkdir(tmpWorkspace, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      reason: 'runtime_workspace_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const { AcpAgent } = await import('@process/agent/acp');

  // Placeholder session object the callbacks close over. We mutate
  // currentTurn to dispatch stream events to whichever turn is
  // active; stale events (arriving after a turn resolves) are
  // dropped because currentTurn resets to null on finish.
  const session: LeadSession = {
    agent: null as unknown as import('@process/agent/acp').AcpAgent,
    teamId,
    leadConversationId,
    backend,
    tmpWorkspace,
    currentTurn: null,
    idleTimer: null,
  };

  const agent = new AcpAgent({
    id: leadConversationId,
    backend,
    cliPath: detection.cliPath,
    workingDir: tmpWorkspace,
    customArgs: detection.acpArgs,
    extra: {
      workspace: tmpWorkspace,
      backend,
      cliPath: detection.cliPath,
      customWorkspace: false,
      customArgs: detection.acpArgs,
      yoloMode: true,
    },
    onStreamEvent: (evt) => {
      if (!session.currentTurn) return;
      if (evt.type === 'content') {
        if (typeof evt.data === 'string') {
          session.currentTurn.accumulator += evt.data;
        } else if (evt.data && typeof evt.data === 'object') {
          const text = (evt.data as { content?: unknown }).content;
          if (typeof text === 'string') session.currentTurn.accumulator += text;
        }
      }
    },
    onSignalEvent: (evt) => {
      if (!session.currentTurn) return;
      if (evt.type === 'finish') {
        const text = session.currentTurn.accumulator.trim();
        const turn = session.currentTurn;
        session.currentTurn = null;
        turn.resolve({ ok: true, text: text.length > 0 ? text : '(runtime returned empty response)' });
      } else if (evt.type === 'error') {
        const reason = typeof evt.data === 'string' ? evt.data : 'runtime_error';
        const turn = session.currentTurn;
        session.currentTurn = null;
        turn.resolve({ ok: false, reason: 'runtime_error', error: reason });
      }
    },
  });
  session.agent = agent;

  try {
    await agent.start();
  } catch (e) {
    await teardownLeadSession(teamId, 'start_failed');
    return {
      ok: false,
      reason: 'runtime_start_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  leadSessions.set(teamId, session);
  scheduleLeadIdleTeardown(session);
  return { ok: true, session };
}

async function runTurnOnLead(
  session: LeadSession,
  jobId: string,
  prompt: string,
  timeoutMs: number
): Promise<{ ok: true; assistantText: string } | { ok: false; reason: string; error: string }> {
  if (session.currentTurn) {
    // Shouldn't happen in practice — master serializes wakes per
    // slot — but guard anyway so we don't interleave accumulators.
    return {
      ok: false,
      reason: 'runtime_busy',
      error: 'Lead session is already handling a turn for this team',
    };
  }
  const result = await new Promise<
    { ok: true; text: string } | { ok: false; reason: string; error: string }
  >((resolve) => {
    session.currentTurn = { accumulator: '', resolve, finishReason: null };
    // Timeout wrapper — mirrors the master's enforced budget so we
    // never hold the ack longer than the master is willing to wait.
    const timer = setTimeout(() => {
      if (session.currentTurn) {
        session.currentTurn = null;
        resolve({
          ok: false,
          reason: 'runtime_timeout',
          error: `Lead turn exceeded ${String(timeoutMs)}ms`,
        });
      }
    }, timeoutMs);
    // Kick off the send — failure here throws synchronously from the
    // CLI path. We treat that as a send-layer failure, not a
    // runtime error.
    void session.agent.sendMessage({ content: prompt, msg_id: jobId }).catch((e) => {
      if (session.currentTurn) {
        session.currentTurn = null;
        clearTimeout(timer);
        resolve({
          ok: false,
          reason: 'runtime_send_failed',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });
    // Clear timer on resolve — wraps the user-supplied resolve.
    const originalResolve = session.currentTurn.resolve;
    session.currentTurn.resolve = (r) => {
      clearTimeout(timer);
      originalResolve(r);
    };
  });

  scheduleLeadIdleTeardown(session);

  if (result.ok) {
    const success = result as { ok: true; text: string };
    return { ok: true, assistantText: success.text };
  }
  const failure = result as { ok: false; reason: string; error: string };
  return { ok: false, reason: failure.reason, error: failure.error };
}

/**
 * v2.4.0 — run the turn through the slave's persistent Lead CLI
 * session. First call for a teamId boots the Lead; subsequent calls
 * reuse the cached session. If no Lead exists yet (pre-v2.4.0 hire
 * or provisioning hasn't landed), returns null so caller falls back
 * to the v2.3.x ephemeral executor.
 */
async function executeViaLead(
  parsed: ExecuteParams,
  timeoutMs: number
): Promise<
  | null
  | { ok: true; assistantText: string; leadConversationId: string }
  | { ok: false; reason: string; error: string }
> {
  if (!parsed.teamId) return null;
  const db = await getDatabase();
  const driver = db.getDriver();
  const leadInfo = await resolveTeamLead(driver, parsed.teamId);
  if (!leadInfo) return null;

  const start = await getOrStartLeadSession(parsed.teamId, leadInfo.leadConversationId, leadInfo.backend);
  if (!start.ok) {
    const failure = start as { ok: false; reason: string; error: string };
    return { ok: false, reason: failure.reason, error: failure.error };
  }

  const prompt = buildAcpPrompt(parsed.messages);
  const turn = await runTurnOnLead(start.session, parsed.jobId, prompt, timeoutMs);
  if (turn.ok) {
    const success = turn as { ok: true; assistantText: string };
    return { ok: true, assistantText: success.assistantText, leadConversationId: leadInfo.leadConversationId };
  }
  const failure = turn as { ok: false; reason: string; error: string };
  // If the CLI died mid-turn, drop the cached session so the next
  // turn re-spawns fresh instead of reusing a broken process.
  if (failure.reason === 'runtime_error' || failure.reason === 'runtime_send_failed') {
    await teardownLeadSession(parsed.teamId, failure.reason);
  }
  return { ok: false, reason: failure.reason, error: failure.error };
}

/**
 * v2.3.0 — run a single turn through the chosen ACP runtime. Spawns
 * the CLI into a per-job temp workspace, fires one prompt, collects
 * the assistant response chunks, kills the subprocess, and cleans up.
 *
 * Returns a structured result either way — the outer handleAgentExecute
 * decides the AckStatus (completed/failed/skipped) based on shape.
 */
async function executeViaAcp(
  parsed: ExecuteParams,
  backend: AcpBackend,
  timeoutMs: number
): Promise<
  | { ok: true; assistantText: string; usage?: Record<string, unknown> }
  | { ok: false; reason: string; error: string }
> {
  // v2.3.1 — look up the CLI path the slave's own detector found
  // at boot. Without this, AcpConnection.connect() throws
  // "CLI path is required for <backend>" for most backends.
  const detection = await resolveCliPathForBackend(backend);
  if (!detection) {
    return {
      ok: false,
      reason: 'runtime_not_detected',
      error: `Backend '${backend}' not detected on this device. Install the CLI and restart TitanX on the slave.`,
    };
  }

  const tmpWorkspace = path.join(os.tmpdir(), `titanx-farm-${parsed.jobId}`);
  try {
    await fs.mkdir(tmpWorkspace, { recursive: true });
  } catch (e) {
    return {
      ok: false,
      reason: 'runtime_workspace_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Lazy import — AcpAgent pulls in the CLI connection layer which
  // is heavy. Keep farmExecutor's hot path lean for paths that don't
  // use ACP.
  const { AcpAgent } = await import('@process/agent/acp');

  let accumulated = '';
  let finishedOk = false;
  let finishReason: string | null = null;
  let resolveFinish: (ok: boolean) => void = () => undefined;
  const finished = new Promise<boolean>((resolve) => {
    resolveFinish = resolve;
  });

  const agent = new AcpAgent({
    id: parsed.jobId,
    backend,
    cliPath: detection.cliPath,
    workingDir: tmpWorkspace,
    customArgs: detection.acpArgs,
    extra: {
      workspace: tmpWorkspace,
      backend,
      cliPath: detection.cliPath,
      customWorkspace: false,
      // v2.3.3 — thread acpArgs from the detector so opencode gets
      // `acp`, goose gets its subcommand, etc. AcpConnection's
      // createGenericSpawnConfig uses these exactly; `undefined`
      // falls back to the old ['--experimental-acp'] default that
      // only works for claude.
      customArgs: detection.acpArgs,
      yoloMode: true, // Headless — auto-approve tool prompts.
    },
    onStreamEvent: (evt) => {
      if (evt.type === 'content') {
        // data is either the chunk text or a JSON-stringified object
        // (see AcpAgent.handleContentChunk fallback). Append raw text.
        if (typeof evt.data === 'string') {
          accumulated += evt.data;
        } else if (evt.data && typeof evt.data === 'object') {
          const text = (evt.data as { content?: unknown }).content;
          if (typeof text === 'string') accumulated += text;
        }
      }
      // Everything else (thought, agent_status, acp_context_usage,
      // acp_tool_call, acp_permission …) is ignored in headless mode.
    },
    onSignalEvent: (evt) => {
      if (evt.type === 'finish') {
        finishedOk = true;
        resolveFinish(true);
      } else if (evt.type === 'error') {
        finishReason = typeof evt.data === 'string' ? evt.data : 'runtime_error';
        resolveFinish(false);
      }
    },
  });

  const cleanup = async () => {
    try {
      await agent.kill();
    } catch (e) {
      logNonCritical('fleet.farm.acp.kill', e);
    }
    try {
      await fs.rm(tmpWorkspace, { recursive: true, force: true });
    } catch (e) {
      logNonCritical('fleet.farm.acp.cleanup', e);
    }
  };

  try {
    await agent.start();
  } catch (e) {
    await cleanup();
    return {
      ok: false,
      reason: 'runtime_start_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const prompt = buildAcpPrompt(parsed.messages);
  try {
    // sendMessage returns when the CLI acks the prompt; the actual
    // turn completion is signaled via onSignalEvent('finish').
    await agent.sendMessage({ content: prompt, msg_id: parsed.jobId });
  } catch (e) {
    await cleanup();
    return {
      ok: false,
      reason: 'runtime_send_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Race the finish signal against the master's timeout.
  const timer = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      if (!finishedOk) {
        finishReason = 'timeout';
        resolve(false);
      }
    }, timeoutMs);
  });

  const ok = await Promise.race([finished, timer]);
  await cleanup();

  if (!ok) {
    return {
      ok: false,
      reason: finishReason ?? 'runtime_timeout',
      error: finishReason === 'timeout' ? `ACP turn exceeded ${String(timeoutMs)}ms` : (finishReason ?? 'unknown'),
    };
  }

  const trimmed = accumulated.trim();
  return {
    ok: true,
    assistantText: trimmed.length > 0 ? trimmed : '(runtime returned empty response)',
  };
}

/**
 * Main handler. Returns a HandlerOutcome the slave executor will
 * serialize into the ack payload.
 */
export async function handleAgentExecute(rawParams: Record<string, unknown>): Promise<HandlerOutcome> {
  const parsed = parseParams(rawParams);
  if (!parsed) {
    return { status: 'skipped', result: { reason: 'invalid_params' } };
  }

  // v2.4.2 — enrollmentRole gate. Only farm-role slaves dispatch
  // farm turns. A workforce slave that somehow receives a stray
  // agent.execute returns a clean skip ack so master audit sees the
  // rejection reason instead of silently running the turn.
  try {
    const role = (await ProcessConfig.get('fleet.enrollmentRole')) as string | undefined;
    if (role !== 'farm') {
      return { status: 'skipped', result: { reason: 'not_farm_role' } };
    }
  } catch (e) {
    logNonCritical('fleet.agent-execute.role-check', e);
    return { status: 'skipped', result: { reason: 'role_check_failed' } };
  }

  const db = await getDatabase();
  const driver = db.getDriver();
  // Placeholder team_id for slave-local job tracking. On the slave
  // the job isn't tied to a local team — it's a one-shot turn — so
  // we stamp a synthetic marker that's still queryable in telemetry.
  const syntheticTeamId = `fleet-job-${parsed.jobId}`;

  try {
    recordJobStart(driver, parsed, syntheticTeamId);
  } catch (e) {
    logNonCritical('fleet.agent-execute.job-start', e);
  }

  const template = loadTemplate(driver, parsed.agentTemplateId);
  if (!template) {
    try {
      recordJobFinish(driver, parsed.jobId, 'failed', {}, 'template_not_found');
    } catch (e) {
      logNonCritical('fleet.agent-execute.job-finish-no-template', e);
    }
    upsertSlaveMirror(driver, parsed, 'Template not found on this device — is it synced from master?');
    return {
      status: 'skipped',
      result: { reason: 'template_not_found', agentTemplateId: parsed.agentTemplateId },
    };
  }

  const timeoutMs = Math.max(1000, (parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS) - TIMEOUT_SAFETY_MARGIN_MS);

  // v2.4.0 — prefer the slave's persistent Lead session when the
  // team was provisioned via `team.farm_provision`. Keeps CLI
  // context warm across master turns + avoids the 2-5s ACP connect
  // cost per message.
  const leadResult = await executeViaLead(parsed, timeoutMs);
  if (leadResult !== null) {
    if (leadResult.ok) {
      const result = {
        jobId: parsed.jobId,
        assistantText: leadResult.assistantText,
        agentTemplateId: parsed.agentTemplateId,
        templateName: template.name,
        runtimeBackend: parsed.runtimeBackend,
        leadConversationId: leadResult.leadConversationId,
        path: 'lead' as const,
      };
      try {
        recordJobFinish(driver, parsed.jobId, 'completed', result);
      } catch (e) {
        logNonCritical('fleet.agent-execute.job-finish-lead-ok', e);
      }
      try {
        logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'fleet_farm_executor',
          action: 'fleet.agent.execute.completed',
          entityType: 'fleet_command',
          entityId: parsed.jobId,
          details: {
            agentTemplateId: parsed.agentTemplateId,
            messagesCount: parsed.messages.length,
            textLength: leadResult.assistantText.length,
            runtimeBackend: parsed.runtimeBackend,
            path: 'lead',
          },
          agentId: parsed.agentTemplateId,
        });
      } catch (e) {
        logNonCritical('fleet.agent-execute.audit-lead-ok', e);
      }
      upsertSlaveMirror(driver, parsed, leadResult.assistantText);
      return { status: 'succeeded', result };
    }
    // Lead path failed — same ack shape as ACP failure, plus surface
    // the fact that the Lead was the target so master audit can
    // distinguish Lead-routed vs ephemeral failures.
    const failure = leadResult as { ok: false; reason: string; error: string };
    try {
      recordJobFinish(driver, parsed.jobId, 'failed', {}, `${failure.reason}:${failure.error}`);
    } catch (e) {
      logNonCritical('fleet.agent-execute.job-finish-lead-fail', e);
    }
    upsertSlaveMirror(
      driver,
      parsed,
      `Lead-routed turn failed (${failure.reason}): ${failure.error}`
    );
    return {
      status: 'failed',
      result: {
        reason: failure.reason,
        error: failure.error,
        runtimeBackend: parsed.runtimeBackend,
        jobId: parsed.jobId,
        path: 'lead',
      },
    };
  }

  // v2.3.0 — ACP runtime dispatch (fallback path when no Lead
  // exists). When the operator picked an ACP backend at hire time
  // (runtimeBackend in the envelope), route the turn through that
  // CLI instead of the LangChain/API path. The CLI owns its own
  // auth + model selection; the slave doesn't need a `model.config`
  // LLM provider.
  if (parsed.runtimeBackend && ACP_DISPATCH_BACKENDS.has(parsed.runtimeBackend)) {
    const acpResult = await executeViaAcp(parsed, parsed.runtimeBackend as AcpBackend, timeoutMs);
    if (acpResult.ok) {
      const result = {
        jobId: parsed.jobId,
        assistantText: acpResult.assistantText,
        usage: acpResult.usage,
        agentTemplateId: parsed.agentTemplateId,
        templateName: template.name,
        runtimeBackend: parsed.runtimeBackend,
      };
      try {
        recordJobFinish(driver, parsed.jobId, 'completed', result);
      } catch (e) {
        logNonCritical('fleet.agent-execute.job-finish-acp-ok', e);
      }
      try {
        logActivity(driver, {
          userId: 'system_default_user',
          actorType: 'system',
          actorId: 'fleet_farm_executor',
          action: 'fleet.agent.execute.completed',
          entityType: 'fleet_command',
          entityId: parsed.jobId,
          details: {
            agentTemplateId: parsed.agentTemplateId,
            messagesCount: parsed.messages.length,
            textLength: acpResult.assistantText.length,
            runtimeBackend: parsed.runtimeBackend,
            path: 'acp',
          },
          agentId: parsed.agentTemplateId,
        });
      } catch (e) {
        logNonCritical('fleet.agent-execute.audit-acp-ok', e);
      }
      upsertSlaveMirror(driver, parsed, acpResult.assistantText);
      return { status: 'succeeded', result };
    }
    // ACP start/send/timeout failure path. TS can't narrow acpResult
    // through the `if (acpResult.ok) return` above across the function
    // boundary — explicit cast to the failure arm.
    const failure = acpResult as { ok: false; reason: string; error: string };
    try {
      recordJobFinish(driver, parsed.jobId, 'failed', {}, `${failure.reason}:${failure.error}`);
    } catch (e) {
      logNonCritical('fleet.agent-execute.job-finish-acp-fail', e);
    }
    upsertSlaveMirror(
      driver,
      parsed,
      `ACP runtime '${parsed.runtimeBackend}' failed (${failure.reason}): ${failure.error}`
    );
    return {
      status: 'failed',
      result: {
        reason: failure.reason,
        error: failure.error,
        runtimeBackend: parsed.runtimeBackend,
        jobId: parsed.jobId,
      },
    };
  }

  // Legacy LangChain path — runtimeBackend absent or not an ACP CLI.
  // Lives on for 'remote' / 'aionrs' / direct-API backends, and for
  // pre-v2.2.2 farm slots that don't stamp runtimeBackend.
  const provider = await resolveProvider(parsed.model);
  if (!provider) {
    try {
      recordJobFinish(driver, parsed.jobId, 'failed', {}, 'no_provider_configured');
    } catch (e) {
      logNonCritical('fleet.agent-execute.job-finish-no-provider', e);
    }
    upsertSlaveMirror(driver, parsed, 'No ACP runtime / LLM provider configured on this device.');
    return { status: 'skipped', result: { reason: 'no_provider_configured' } };
  }

  // LangChain's BaseChatModel uses a message array shape that's
  // slightly different from our envelope's {role, content}. The
  // ChatOpenAI / ChatAnthropic wrappers accept both LC messages and
  // OpenAI-style role/content arrays; we pass the latter for minimal
  // transform overhead.
  try {
    const { createChatModel } = await import('@process/services/deepAgent/langgraph/providers');
    const model = await createChatModel(provider);

    const invokePromise = model.invoke(parsed.messages);
    const response = await withTimeout(invokePromise, timeoutMs);

    const assistantText =
      typeof response.content === 'string'
        ? response.content
        : // LangChain may return an array of content parts; join the text ones.
          Array.isArray(response.content)
          ? response.content
              .map((part) =>
                typeof part === 'object' &&
                part &&
                'text' in part &&
                typeof (part as { text: unknown }).text === 'string'
                  ? (part as { text: string }).text
                  : ''
              )
              .filter((s) => s.length > 0)
              .join('\n')
          : '';

    // usage_metadata is LangChain's unified field (may be absent).
    const usage =
      typeof (response as { usage_metadata?: unknown }).usage_metadata === 'object' &&
      (response as { usage_metadata?: Record<string, unknown> }).usage_metadata != null
        ? (response as { usage_metadata: Record<string, unknown> }).usage_metadata
        : undefined;

    const result = {
      jobId: parsed.jobId,
      assistantText,
      usage,
      agentTemplateId: parsed.agentTemplateId,
      templateName: template.name,
    };

    try {
      recordJobFinish(driver, parsed.jobId, 'completed', result);
    } catch (e) {
      logNonCritical('fleet.agent-execute.job-finish-ok', e);
    }

    // v2.2.1 — write the slave-side mirror so the operator can see
    // the farm work in this device's own Teams UI. Best-effort; any
    // error is logged and the turn still completes.
    upsertSlaveMirror(driver, parsed, assistantText);

    try {
      logActivity(driver, {
        userId: 'system_default_user',
        actorType: 'system',
        actorId: 'fleet_farm_executor',
        action: 'fleet.agent.execute.completed',
        entityType: 'fleet_command',
        entityId: parsed.jobId,
        details: {
          agentTemplateId: parsed.agentTemplateId,
          messagesCount: parsed.messages.length,
          textLength: assistantText.length,
        },
        agentId: parsed.agentTemplateId,
      });
    } catch (e) {
      logNonCritical('fleet.agent-execute.audit-ok', e);
    }

    return { status: 'succeeded', result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const isTimeout = message === 'AGENT_EXECUTE_TIMEOUT';
    try {
      recordJobFinish(driver, parsed.jobId, isTimeout ? 'timeout' : 'failed', {}, message);
    } catch (finishErr) {
      logNonCritical('fleet.agent-execute.job-finish-err', finishErr);
    }
    // v2.2.1 — mirror the prompt + failure reason so the slave operator
    // sees what went wrong in their Teams UI.
    upsertSlaveMirror(driver, parsed, `Execution failed: ${message}`);
    return {
      status: isTimeout ? 'skipped' : 'failed',
      result: {
        reason: isTimeout ? 'timeout' : 'provider_error',
        error: message,
        jobId: parsed.jobId,
      },
    };
  }
}

/** Exported helper for tests — jobId generator that matches the master side. */
export function generateJobId(): string {
  return crypto.randomUUID();
}
