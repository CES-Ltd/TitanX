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
import { getDatabase } from '@process/services/database';
import { ProcessConfig } from '@process/utils/initStorage';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import type { AckStatus } from './types';

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
 * Main handler. Returns a HandlerOutcome the slave executor will
 * serialize into the ack payload.
 */
export async function handleAgentExecute(rawParams: Record<string, unknown>): Promise<HandlerOutcome> {
  const parsed = parseParams(rawParams);
  if (!parsed) {
    return { status: 'skipped', result: { reason: 'invalid_params' } };
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

  const timeoutMs = Math.max(1000, (parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS) - TIMEOUT_SAFETY_MARGIN_MS);

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
