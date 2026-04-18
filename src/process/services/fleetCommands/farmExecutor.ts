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
  };
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
