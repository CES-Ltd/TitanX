/**
 * @license Apache-2.0
 * Agent Workflow Builder — Phase 2 extended handlers.
 *
 * Adds the next tier of node types beyond the Phase 1 11:
 *   - `parallel.fan_out`  — emit a fan-out envelope so the dispatcher
 *                           can activate multiple downstream steps.
 *   - `parallel.join`     — wait for all predecessors to complete
 *                           before advancing (see dispatcher support).
 *   - `human.approve`     — pause the run with status='paused' and
 *                           surface a human-approval requirement;
 *                           resumed via the IPC resume channel.
 *   - `memory.recall`     — cheap read-only lookup against
 *                           reasoningBank trajectories for the current
 *                           agent, returning top-K similar past
 *                           outcomes.
 *
 * Phase 2 dispatcher support for parallel activation + pause-for-
 * human lands alongside these handlers as tiny dispatcher patches;
 * the registration itself is additive and doesn't regress Phase 1.
 *
 * Note — these handlers are NON-deferred (no `__deferred: true`
 * envelope). `human.approve` signals pause via
 * `__pauseReason = 'human_approval_required'`; the dispatcher maps
 * it to a status transition. `parallel.fan_out` sets
 * `__fanOut = true`; the dispatcher's edge walker honors it. Both
 * are additive hints on top of the standard output shape.
 */

import { registerNodeHandler } from '../../engine';
import { AGENT_CONTEXT_KEY, type HandlerAgentContext } from './promptHandlers';

function getCtx(inputData: Record<string, unknown>): HandlerAgentContext | undefined {
  return inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
}

// ── parallel.fan_out ─────────────────────────────────────────────────────────
/**
 * Emits a hint the dispatcher can use to activate multiple
 * downstream edges at once. Phase 1 dispatcher already follows all
 * outgoing edges from a non-condition node; fan_out is a marker for
 * visualization + a future parallel.join that waits on all branches.
 */
registerNodeHandler('parallel.fan_out', async (_node, inputData) => {
  return { __fanOut: true, startedAt: Date.now(), fromState: Object.keys(getCtx(inputData)?.state ?? {}) };
});

// ── parallel.join ────────────────────────────────────────────────────────────
/**
 * Join node — waits for all incoming branches before advancing.
 *
 * v2.6.0 Phase 2.x: the dispatcher's `computeNextActiveSteps` enforces
 * the wait by filtering candidate activations: a `parallel.join` is
 * only activated when every one of its incoming-edge sources is in
 * `completedStepIds`. Single-predecessor joins behave like any other
 * node (the "all predecessors" check trivially passes). For multi-
 * predecessor joins, the first completed predecessor's walk finds
 * the join not-yet-ready; later predecessors' walks re-evaluate and
 * the last one flips it active.
 *
 * The handler itself just marks the join as settled and stamps a
 * timestamp so the debug viewer can surface "joined at".
 */
registerNodeHandler('parallel.join', async () => {
  return { __join: true, joinedAt: Date.now() };
});

// ── human.approve ────────────────────────────────────────────────────────────
/**
 * Signal a human-approval checkpoint. Returns a pause envelope —
 * the dispatcher, on seeing `__pauseReason`, transitions the run
 * to 'paused' and surfaces the pending approval via the UI (debug
 * viewer shows a "Resume" button). The actual approval decision is
 * recorded on the next invocation via `node.parameters.approvalNote`
 * if set by the resumer.
 */
registerNodeHandler('human.approve', async (node) => {
  const reason = (node.parameters.reason as string | undefined) ?? 'Manual approval required to continue';
  return {
    __pauseReason: 'human_approval_required',
    __pausePromptTemplate: reason,
    pendingAt: Date.now(),
  };
});

// ── acp.slash.invoke ─────────────────────────────────────────────────────────
/**
 * Invoke an ACP runtime slash command on the next agent turn.
 *
 * Slash commands live on the ACP protocol (e.g. `/compact`,
 * `/clear`, `/resume`, agent-specific ones like `/codex`). The ACP
 * backend parses them out of the next user message and runs them
 * as protocol actions rather than LLM generations.
 *
 * We model this as a deferred handler whose `promptTemplate` is
 * literally the slash command string — the dispatcher will inject
 * it into the next turn via presetContext, the agent sees
 * `/<command> <args...>` at the top of its context, and the ACP
 * runtime handles the rest. No IAM gate at this layer — the ACP
 * backend's allowlist (SlashCommandAvailability) is the real gate.
 *
 * Parameters:
 *   - `command` (string, required) — slash command name without the
 *     leading slash. e.g. `"compact"` → invokes `/compact`.
 *   - `args` (string[] | string, optional) — space-joined into the
 *     command. Supports `{{var.X}}` templating against the run's
 *     state bag (same as prompt.* handlers).
 *
 * Completion — the handler returns a deferred envelope; the next
 * turn's output is captured as the step's result, same as
 * prompt.freeform. Since slash commands typically produce their
 * output as the agent's response text, the capture is
 * straightforward.
 */
registerNodeHandler('acp.slash.invoke', async (node, inputData) => {
  const cmdName = ((node.parameters.command as string) ?? '').trim();
  if (!cmdName) {
    throw new Error('acp.slash.invoke: `command` parameter is required');
  }
  const rawArgs = node.parameters.args;
  const argsArray: string[] = Array.isArray(rawArgs)
    ? rawArgs.map((a) => String(a))
    : typeof rawArgs === 'string'
      ? [rawArgs]
      : [];

  // Reuse the prompt-family templating helper so `{{var.X}}` works
  // inside command args identically to how it works in prompt
  // templates. Late import to avoid a circular boot-order import
  // between extendedHandlers (required by the barrel at bootstrap)
  // and promptHandlers' exports.
  const { renderPromptTemplate } = await import('./promptHandlers');
  const state = getCtx(inputData)?.state ?? {};
  const renderedArgs = argsArray.map((a) => renderPromptTemplate(a, state));

  const promptTemplate = ['/' + cmdName, ...renderedArgs].join(' ').trim();
  return {
    __deferred: true,
    promptTemplate,
    completionCriteria: `Slash command /${cmdName} must have been recognized + executed by the ACP runtime.`,
  };
});

// ── memory.recall ────────────────────────────────────────────────────────────
/**
 * Read-only lookup against reasoningBank trajectories. Returns the
 * top-K similar past trajectories for the current agent's task,
 * plus the most recent one. Used as an "experience prior" by a
 * subsequent prompt.plan/freeform step — `{{var.memory.recallResult}}`
 * templating picks it up. Missing reasoning bank / no prior
 * trajectories returns `{ results: [] }`.
 */
registerNodeHandler('memory.recall', async (node, inputData, context) => {
  const ctx = getCtx(inputData);
  if (!ctx) return { results: [] };
  const taskDescription = (node.parameters.query as string | undefined) ?? '';
  const limit = (node.parameters.limit as number | undefined) ?? 5;

  try {
    // Late import — reasoningBank is an optional companion service;
    // workflow dispatch mustn't hard-fail if its module is missing.
    const reasoningBank = await import('@process/services/reasoningBank');
    const trajectories = reasoningBank.findSimilarTrajectories?.(context.db, taskDescription, limit) as
      | Array<{ id: string; taskDescription: string; successScore: number; createdAt: number }>
      | undefined;
    return {
      results: (trajectories ?? []).map((t) => ({
        id: t.id,
        task: t.taskDescription,
        successScore: t.successScore,
        createdAt: t.createdAt,
      })),
      count: trajectories?.length ?? 0,
    };
  } catch {
    return { results: [], count: 0 };
  }
});
