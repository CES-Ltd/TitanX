/**
 * @license Apache-2.0
 * Agent Workflow Builder — node handler barrel.
 *
 * Side-effect import. Loading this file registers all agent-specific
 * node handlers (prompt.*, tool.git.*, sprint.*) on the shared
 * `registerNodeHandler` registry in `../../engine.ts`. Handlers are
 * registered at import time — there's no runtime init function to
 * call — so a single `import './handlers/agent'` at bootstrap is
 * enough to make them dispatchable.
 *
 * Bootstrap wiring happens from `src/process/utils/initStorage.ts`
 * at app launch, before any workflow can fire. Importing here
 * (rather than depending on every caller to import individual files)
 * keeps the registration order consistent and matches the pattern
 * used by `seedBuiltinBlueprints` / `seedBuiltinAssistantRules`.
 *
 * Re-exports the context-sentinel key + render helper so the
 * dispatcher and tests can share the exact same contract handlers
 * see at invocation time.
 */

import './promptHandlers';
import './gitHandlers';
import './sprintHandlers';

export {
  AGENT_CONTEXT_KEY,
  type HandlerAgentContext,
  type PromptDeferredOutput,
  renderPromptTemplate,
} from './promptHandlers';
