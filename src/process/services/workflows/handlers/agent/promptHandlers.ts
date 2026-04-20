/**
 * @license Apache-2.0
 * Agent Workflow Builder — prompt family handlers.
 *
 * These handlers don't "do work" in the traditional sense — they
 * prepare a prompt template that the dispatcher will inject into the
 * agent's next turn via `presetContext`, and return a *deferred*
 * envelope. The agent's LLM drives the intelligence; the handler just
 * frames the step.
 *
 * Deferred-envelope protocol:
 *
 *   Returned output shape:
 *     {
 *       __deferred: true,
 *       promptTemplate: string,     // rendered instruction text
 *       outputSchema?: unknown,     // Phase 1: passed through as-is,
 *                                   // Phase 2 will validate parsed output
 *       completionCriteria?: string // human-readable acceptance note
 *     }
 *
 *   The dispatcher reads `__deferred === true` to decide whether to
 *   inject context + wait for the next turn (deferred) vs. advance
 *   immediately (non-deferred tool/sprint steps). Captured next-turn
 *   output is later stitched into `agent_workflow_runs.state_json` by
 *   `TurnFinalizer.evaluateAgentWorkflowStep()`.
 *
 * Four registered node types:
 *
 *   - prompt.plan          — free-form "make a plan" instruction
 *   - prompt.create_todo   — schema = array of `{title, ownerHint?}`
 *   - prompt.review        — schema = `{approved: boolean, issues: string[]}`
 *   - prompt.freeform      — custom template via node.parameters.promptTemplate
 *
 * Templating — `{{var.X}}` substitutions against `inputData.__agent.state`
 * (see AGENT_CONTEXT_KEY). Agent context is expected under that key;
 * missing context renders `{{var.X}}` literals unchanged so the
 * handler still returns something useful for tests / dry-run.
 */

import { registerNodeHandler } from '../../engine';

/**
 * Well-known key the dispatcher uses to stash per-run context on
 * inputData. Re-exported for the dispatcher + tests. Picked as a
 * reserved-looking sentinel so it cannot collide with workflow
 * variable names.
 */
export const AGENT_CONTEXT_KEY = '__agent';

/** Shape of the context the dispatcher stashes at inputData[AGENT_CONTEXT_KEY]. */
export type HandlerAgentContext = {
  runId: string;
  slotId: string;
  teamId?: string;
  conversationId?: string;
  agentGalleryId?: string;
  /** Workflow-level variables + outputs written by prior steps. */
  state: Record<string, unknown>;
};

/** Deferred-envelope return shape used by every prompt.* handler. */
export type PromptDeferredOutput = {
  __deferred: true;
  promptTemplate: string;
  outputSchema?: unknown;
  completionCriteria?: string;
};

/**
 * Substitute `{{var.X}}` tokens against a state bag. Left alone when
 * the key is missing — surface-visible "unresolved template" hints in
 * the rendered prompt are more useful than silent blanks during
 * authoring. Keeps the substitution deliberately narrow: one well-
 * known prefix (`var.`), no expression evaluation. Fancier templating
 * lands in Phase 2 alongside the visual builder.
 */
export function renderPromptTemplate(template: string, state: Record<string, unknown>): string {
  return template.replace(/\{\{var\.([a-zA-Z0-9_.]+)\}\}/g, (match, path: string) => {
    const keys = path.split('.');
    let current: unknown = state;
    for (const key of keys) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return match;
      }
    }
    return current === undefined || current === null ? match : String(current);
  });
}

function extractAgentState(inputData: Record<string, unknown>): Record<string, unknown> {
  const ctx = inputData[AGENT_CONTEXT_KEY] as HandlerAgentContext | undefined;
  return ctx?.state ?? {};
}

function buildDeferredOutput(
  node: { parameters: Record<string, unknown> },
  defaultTemplate: string,
  defaultSchema?: unknown
): PromptDeferredOutput {
  const template = (node.parameters.promptTemplate as string | undefined) ?? defaultTemplate;
  const schema = (node.parameters.outputSchema as unknown) ?? defaultSchema;
  const criteria = (node.parameters.completionCriteria as string | undefined) ?? undefined;
  return {
    __deferred: true,
    promptTemplate: template,
    outputSchema: schema,
    completionCriteria: criteria,
  };
}

registerNodeHandler('prompt.plan', async (node, inputData) => {
  const envelope = buildDeferredOutput(
    node,
    'Create a concise step-by-step plan for the current task. List the ordered steps; do not execute them yet.'
  );
  const state = extractAgentState(inputData);
  return { ...envelope, promptTemplate: renderPromptTemplate(envelope.promptTemplate, state) };
});

registerNodeHandler('prompt.create_todo', async (node, inputData) => {
  const envelope = buildDeferredOutput(
    node,
    'Break the current task into a list of concrete todos. Respond with an array of `{ "title": string, "ownerHint"?: string }` objects.',
    { type: 'array', items: { title: 'string', ownerHint: 'string?' } }
  );
  const state = extractAgentState(inputData);
  return { ...envelope, promptTemplate: renderPromptTemplate(envelope.promptTemplate, state) };
});

registerNodeHandler('prompt.review', async (node, inputData) => {
  const envelope = buildDeferredOutput(
    node,
    'Review the prior step output. Respond with `{ "approved": boolean, "issues": string[] }`. Be strict: only approve if there are zero issues.',
    { approved: 'boolean', issues: 'string[]' }
  );
  const state = extractAgentState(inputData);
  return { ...envelope, promptTemplate: renderPromptTemplate(envelope.promptTemplate, state) };
});

registerNodeHandler('prompt.freeform', async (node, inputData) => {
  const envelope = buildDeferredOutput(node, 'Continue the current task.');
  const state = extractAgentState(inputData);
  return { ...envelope, promptTemplate: renderPromptTemplate(envelope.promptTemplate, state) };
});
