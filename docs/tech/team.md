# Team Module Architecture

The `src/process/team/` module implements TitanX's multi-agent
orchestration system — a single lead agent coordinates a roster of
teammate agents via a shared mailbox, a sprint board, and MCP tools.

This doc captures the module's _current_ shape after the Phase 3
refactor (v1.9.20 through v1.9.22). For the motivating issues see
`docs/adr/agent-loop-v2.md`; for hook extensibility see `hooks.md`.

---

## Layout

```
src/process/team/
├── TeammateManager.ts        ← thin orchestrator (~880 LOC)
├── AgentRegistry.ts          ← agents[] + lookup helpers
├── WakeState.ts              ← pure wake bookkeeping
├── WakeRunner.ts             ← async side of wake cycle
├── ResponseStreamBuffer.ts   ← per-conv stream accumulation
├── ActionExecutor.ts         ← parsed-action dispatch
├── TurnFinalizer.ts          ← post-turn observability
├── Mailbox.ts                ← inter-agent message store
├── TaskManager.ts            ← sprint board CRUD
├── TeamMcpServer.ts          ← MCP tool surface for agents
├── TeamSession.ts            ← per-team runtime session
├── TeamSessionService.ts     ← session lifecycle + persistence
├── conversationTypes.ts      ← backend capability registry
├── config.ts                 ← env-overridable tunables
├── types.ts                  ← shared type re-exports
├── teamEventBus.ts           ← in-process event fanout
├── adapters/                 ← payload + XML parsing
├── prompts/                  ← lead + teammate system prompts
├── ports/                    ← IEventPublisher (DI port)
└── repository/               ← ITeamRepository (SQLite impl)
```

Every file has a single responsibility and a paired test under
`tests/unit/` (file-basename.test.ts). The god-object `TeammateManager`
that used to sit at 1,364 LOC became a thin coordinator at ~880 LOC
by extracting six single-purpose collaborators.

---

## Core collaborators

### `TeammateManager`

The orchestration entry point. Owns the EventEmitter surface that
external services (IPC, UI) listen on, wires the collaborators, and
hosts cross-cutting public methods (`wake`, `setStatus`, `addAgent`,
`removeAgent`, `renameAgent`, `dispose`).

TeammateManager _never_ implements behavior that can be extracted.
When a method grows past delegating to collaborators + publishing
events, that's a signal to extract another collaborator.

### `AgentRegistry` — agents[] single source of truth

Pure state: `agents[]`, `ownedConversationIds` Set, `renamedAgents`
Map. No events, no audit, no DB. Mutations return prior snapshots so
the caller can diff for event publishing.

Back-compat: TeammateManager still exposes `get agents()` that
forwards to `registry.list()`, so call sites that read the array
work without modification.

### `WakeState` — pure wake bookkeeping

Owns the three sets/maps that coordinate the wake cycle:

- `activeWakes: Set<slotId>` — which agents are mid-turn
- `pendingWakes: Set<slotId>` — wakes that arrived while busy
- `wakeTimeouts: Map<slotId, NodeJS.Timeout>` — watchdogs

No I/O. No async. Trivially testable with fake timers.

### `WakeRunner` — async side of wake

Drives a single agent turn: queue-if-active, mailbox read, payload
build, adapter message dispatch, watchdog arm, retry-once-on-failure,
give-up-and-mark-failed. Uses the context-bundle pattern — all
collaborators injected via `WakeContext`.

### `ResponseStreamBuffer` — stream accumulation

Per-conversation text buffer plus a finalized-turn tracker so dup
`finish` events don't process twice. Bounded at
`TEAM_CONFIG.RESPONSE_BUFFER_MAX_BYTES`; overflow truncates oldest.

### `ActionExecutor` — parsed-action dispatch

Handles the 10 parsed-action cases (send_message, task_create,
task_update, spawn_agent, idle_notification, plain_response,
write_plan, reflect, trigger_workflow, plus policy gate). One method
per case, each with its own error handling.

### `TurnFinalizer` — post-turn observability

Runs six non-blocking observers after every turn: ReasoningBank
trajectory store, queen-mode drift detection, cost + audit write,
agent memory buffer/prune, auto-plan creation, trace run emission.
Each wrapped in `logNonCritical` so one observer's failure never
blocks the others.

---

## Wake cycle (happy path)

```
TeammateManager.wake(slotId)
    │
    ▼
WakeRunner.wake(slotId)
    │
    ├── WakeState.isActive? ── yes ─▶ queueIfActive, audit, return
    │
    ├── AgentRegistry.findBySlotId ── miss ─▶ return
    │
    ├── WakeState.markActive
    │
    ├── setStatus(pending → idle → active)
    │
    ├── createAdapter(conversationType, hasMcp)
    │
    ├── Promise.all(mailbox.readUnread, taskManager.list)
    │
    ├── writeIncomingToConversation(teammate messages → UI bubbles)
    │
    ├── adapter.buildPayload → platform message
    │
    ├── streamBuffer.resetFor(conversationId)
    │
    ├── workerTaskManager.getOrBuildTask → sendMessage
    │
    ├── WakeState.releaseActive  (immediately after send, for deadlock safety)
    │
    └── WakeState.scheduleTimeout(WAKE_TIMEOUT_MS, → idle on still-active)

   (async: stream events arrive via teamEventBus → handleResponseStream →
    streamBuffer.append → eventual finish → finalizeTurn)
```

On any throw inside WakeRunner:

- if no retry pending → mark retry, arm `retryDelayMs` timer, retry once
- else → setStatus('failed'), clear retry marker, give up

---

## Turn-completion path

```
finalizeTurn(conversationId)
    │
    ├── streamBuffer.isFinalized? ── yes ─▶ return (dedup)
    ├── streamBuffer.markFinalized + auto-clear after 5s
    │
    ├── AgentRegistry.findByConversationId ── miss ─▶ return
    ├── streamBuffer.take(conversationId) → accumulatedText
    ├── WakeState.releaseActive + clearTimeout
    │
    ├── maybe process pendingWakes.dequeue → re-wake after 500ms
    │
    ├── adapter.parseResponse(accumulatedText) → ParsedAction[]
    │
    ├── for each serial action (non-send_message):
    │       runHooks(PreToolUse) ── blocked? skip
    │       actionExecutor.execute(action, slotId)
    │       runHooks(PostToolUse)
    │
    ├── turnFinalizer.observeTurn(...)      ← observability cluster
    │
    ├── send_message batch: write all mailboxes in order,
    │                      then wake all targets in parallel,
    │                      (handles shutdown_approved / shutdown_rejected)
    │
    ├── setStatus(idle) if still active
    │
    ├── auto-re-wake if teammate still has in-progress tasks
    │
    └── auto-send idle notification to lead if not explicit
```

---

## Context-bundle DI pattern

Every collaborator (WakeRunner, ActionExecutor, TurnFinalizer) takes
a single context bundle at construction time instead of a wide
constructor signature:

```ts
export type WakeContext = {
  teamId: string;
  registry: AgentRegistry;
  wakeState: WakeState;
  streamBuffer: ResponseStreamBuffer;
  mailbox: Mailbox;
  taskManager: TaskManager;
  workerTaskManager: IWorkerTaskManager;
  setStatus: (slotId, status, msg?) => void;
  createAdapter: (conversationType, hasMcp) => TeamPlatformAdapter;
  agentHasMcpTools: (agent) => boolean;
  mcpServerStarted: () => boolean;
  getAvailableAgentTypes: () => AvailableAgentType[];
  emitIncomingMessage: (msg) => void;
  debugTeam?: (...args) => void;
};
```

Why:

1. **Testability.** Tests build a plain object matching the shape —
   no need to instantiate TeammateManager, Electron, or a real DB.
2. **Wide-but-explicit.** You can see every dependency at the call
   site rather than reading through ~15 constructor args.
3. **Scoped.** The bundle contains only what that collaborator
   needs. ActionExecutor's context differs from WakeRunner's.

---

## Capability registry: `conversationTypes.ts`

Every backend's quirks live in one table:

```ts
{
  acp:              { supportsMcpInjection: true,  sendShape: 'content', provider: 'anthropic' },
  gemini:           { supportsMcpInjection: true,  sendShape: 'input',   provider: 'google'    },
  aionrs:           { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  'openclaw-gateway':{ supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  nanobot:          { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
  remote:           { supportsMcpInjection: false, sendShape: 'content', provider: 'anthropic' },
}
```

Unknown types get a conservative default (no MCP, content shape,
anthropic provider). Adding a new backend is a one-line registry edit
— no more editing `MCP_CAPABLE_TYPES` in TeammateManager, the gemini
check in WakeRunner, and the provider switch in TurnFinalizer.

Helpers exposed:

- `capabilityFor(type)` — full record
- `supportsMcpInjection(type)` — MCP check
- `sendShapeFor(type)` — `'input' | 'content'`
- `costProviderFor(type)` — `'google' | 'anthropic'`
- `resolveConversationType(agentType)` — user-visible agentType
  (claude / codex / opencode / hermes / …) → internal
  conversationType (acp, gemini, aionrs, …)

---

## Event flow

TeammateManager publishes typed events through `IEventPublisher` (the
port in `ports/IEventPublisher.ts`). The shared map:

```ts
type TeamEventMap = {
  'team.agent-status-changed': ITeamAgentStatusEvent;
  'team.message-stream': ITeamMessageEvent;
  'team.agent-spawned': ITeamAgentSpawnedEvent;
  'team.agent-removed': ITeamAgentRemovedEvent;
  'team.agent-renamed': ITeamAgentRenamedEvent;
  'live.activity': IActivityEntry;
};
```

Production wires `defaultIpcEventPublisher.ts` which forwards to
the global `ipcBridge`. Tests inject `NoopEventPublisher` or a spy.

This port broke a circular dependency: `team/` used to do
`require('@/common')` dynamically in TaskManager and activityLog to
reach `ipcBridge`. Now only the composition root (`src/index.ts`)
touches both layers.

---

## Configuration: `config.ts`

All timing constants live in one place and can be overridden via
env vars:

| Constant                    | Default   | Env var                      |
| --------------------------- | --------- | ---------------------------- |
| `WAKE_TIMEOUT_MS`           | 60 000    | `TITANX_WAKE_TIMEOUT_MS`     |
| `RETRY_DELAY_MS`            | 3 000     | `TITANX_RETRY_DELAY_MS`      |
| `MEMORY_SWEEP_INTERVAL_MS`  | 60 000    | `TITANX_MEMORY_SWEEP_MS`     |
| `MCP_RATE_LIMIT_MAX`        | 30        | `TITANX_MCP_RATE_LIMIT_MAX`  |
| `RESPONSE_BUFFER_MAX_BYTES` | 1 000 000 | `TITANX_RESPONSE_BUFFER_MAX` |

Each value is clamped to sane bounds at boot (see `config.ts`).

---

## Testing posture

Every collaborator has a paired unit test under `tests/unit/`:

| Source                    | Test                           | Coverage |
| ------------------------- | ------------------------------ | -------- |
| `AgentRegistry.ts`        | `AgentRegistry.test.ts`        | 39 tests |
| `WakeState.ts`            | `WakeState.test.ts`            | 12 tests |
| `WakeRunner.ts`           | `WakeRunner.test.ts`           | 14 tests |
| `ResponseStreamBuffer.ts` | `ResponseStreamBuffer.test.ts` | 14 tests |
| `ActionExecutor.ts`       | `ActionExecutor.test.ts`       | 16 tests |
| `TurnFinalizer.ts`        | `TurnFinalizer.test.ts`        | 20 tests |
| `Mailbox.ts`              | `TeamMailbox.test.ts`          | —        |
| `TaskManager.ts`          | `TeamTaskManager.test.ts`      | —        |
| `config.ts`               | `TeamConfig.test.ts`           | —        |
| `conversationTypes.ts`    | `conversationTypes.test.ts`    | 16 tests |
| `prompts/*`               | `teamPrompts.test.ts`          | 22 tests |

Convention: tests don't touch real SQLite. They pass an `ISqliteDriver`
stub that records SQL execs + prepared statement calls. Electron
Module ABI (136) differs from plain Node ABI (127), so native
`better-sqlite3` can't load in Vitest anyway — the driver interface is
the escape hatch.

---

## Adding a new backend

1. **Register capability.** Add an entry to
   `CAPABILITIES` in `conversationTypes.ts` with the backend's MCP
   support, send-shape, and provider.
2. **Map agentType.** If users pick this backend via a user-visible
   label, extend `resolveConversationType()` to translate it.
3. **Verify.** Existing tests pass. Add a case in
   `conversationTypes.test.ts` asserting the registration.

That's it. `TeammateManager`, `WakeRunner`, `TurnFinalizer`, and
`TeamSessionService` all consult the registry — none of them care what
backends exist.

---

## Adding a new action type

1. Extend the `ParsedAction` discriminated union in `types.ts`.
2. Add a case to `xmlFallbackAdapter.parseXmlActions` that emits it.
3. Add a `handleFoo` method + case to `ActionExecutor.dispatch`.
4. Add tests to `ActionExecutor.test.ts` + the adapter tests.

The executor dispatches via a plain switch (not a registry) because
the action set is small, known, and strongly typed. Adding a registry
here would be premature generalization — reconsider only if we reach
15+ action types.
