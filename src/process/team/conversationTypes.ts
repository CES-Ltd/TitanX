/**
 * @license Apache-2.0
 * Conversation-type capability registry.
 *
 * Centralizes the scattered `conversationType === 'gemini'` and
 * `MCP_CAPABLE_TYPES.has(...)` conditionals that used to live in
 * TeammateManager / WakeRunner / TurnFinalizer / TeamSessionService.
 *
 * Every backend's quirks are captured in one place:
 *   - supportsMcpInjection: whether MCP tools can be loaded into the
 *     AgentManager session. Set for ACP-compatible backends + Gemini.
 *   - sendShape: `{ input }` vs `{ content }` — Gemini's AgentManager
 *     expects `input`, everyone else expects `content`.
 *   - provider: logical provider label used by cost tracking
 *     (`google` for Gemini, `anthropic` default for everything else).
 *
 * New conversation types register here once; callers consult the
 * registry instead of growing another switch statement.
 *
 * NOTE: `agentType` (the user-visible backend label) and `conversationType`
 * (the AgentManager protocol family) are related but not identical —
 * e.g. agentType "codex", "opencode", "hermes" all map to
 * conversationType "acp". Callers that need the mapping use
 * `resolveConversationType()` below.
 */

/** Shape of the send-message payload expected by a backend's AgentManager. */
export type SendShape = 'input' | 'content';

/** Logical cost-tracking provider label. */
export type CostProvider = 'google' | 'anthropic';

/** Per-conversation-type capability snapshot. */
export type ConversationCapability = {
  /** True if the team MCP server can inject tools into this backend's session. */
  supportsMcpInjection: boolean;
  /** Send-message payload shape for this backend. */
  sendShape: SendShape;
  /** Provider label used for cost attribution. */
  provider: CostProvider;
};

/**
 * Default capability applied when a conversation type has no registered
 * entry. Conservative defaults: assume content-shape, anthropic provider,
 * no MCP injection.
 */
const DEFAULT_CAPABILITY: ConversationCapability = {
  supportsMcpInjection: false,
  sendShape: 'content',
  provider: 'anthropic',
};

/**
 * Registered capabilities keyed by conversationType. Reads the AgentManager
 * protocol family, NOT the user-visible agentType label.
 *
 * Currently:
 *   - acp: ACP protocol — supports MCP tool injection via session/new
 *   - gemini: Google Gemini CLI — accepts MCP tools AND uses { input }
 *   - aionrs / openclaw-gateway / nanobot / remote: legacy / non-MCP
 */
const CAPABILITIES: Readonly<Record<string, ConversationCapability>> = Object.freeze({
  acp: { supportsMcpInjection: true, sendShape: 'content', provider: 'anthropic' },
  gemini: { supportsMcpInjection: true, sendShape: 'input', provider: 'google' },
  aionrs: { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  'openclaw-gateway': { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  nanobot: { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  remote: { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
});

/**
 * Look up capability for a given conversation type. Unknown types get the
 * conservative default (no MCP, content shape, anthropic provider).
 */
export function capabilityFor(conversationType: string): ConversationCapability {
  return CAPABILITIES[conversationType] ?? DEFAULT_CAPABILITY;
}

/** Convenience: does this conversation type support MCP tool injection? */
export function supportsMcpInjection(conversationType: string): boolean {
  return capabilityFor(conversationType).supportsMcpInjection;
}

/** Convenience: send-message payload shape for this conversation type. */
export function sendShapeFor(conversationType: string): SendShape {
  return capabilityFor(conversationType).sendShape;
}

/** Convenience: cost provider label for this conversation type. */
export function costProviderFor(conversationType: string): CostProvider {
  return capabilityFor(conversationType).provider;
}

/**
 * Map a user-visible `agentType` (the backend label users pick in the UI)
 * to the internal `conversationType` (AgentManager protocol family).
 *
 * The mapping is lossy: "codex", "opencode", "hermes" all use ACP.
 * Unknown agentTypes default to 'acp' to keep new backends working with
 * the largest common denominator.
 */
export function resolveConversationType(agentType: string): string {
  switch (agentType) {
    case 'gemini':
      return 'gemini';
    case 'aionrs':
      return 'aionrs';
    case 'openclaw-gateway':
      return 'openclaw-gateway';
    case 'nanobot':
      return 'nanobot';
    case 'remote':
      return 'remote';
    // codex, opencode, hermes, claude, and unknown types all ride the ACP rail
    default:
      return 'acp';
  }
}

/**
 * All registered conversation types — useful for iteration in tests
 * or to render a capability matrix in debug UI.
 */
export function registeredConversationTypes(): readonly string[] {
  return Object.keys(CAPABILITIES);
}
