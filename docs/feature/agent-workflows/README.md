# Agent Workflow Builder (v2.6.0)

> Node-based procedural sequences bound to agents at hire time. The LLM drives intelligence *inside* each step; TitanX enforces step ordering, branching, completion criteria, and retry policy *between* steps.

## TL;DR

1. Enable the feature in **/governance → Security → Agent Workflow Builder** (opt-in; default off).
2. Pick a workflow when hiring a teammate (Add Agent modal → *Workflow (optional)*) or set `default_workflow_id` on the gallery template.
3. Every turn the bound agent takes, the dispatcher advances one step of the bound workflow and injects context into the next user prompt.

No agent with no binding is affected in any way — behavior matches pre-v2.6.0 exactly.

## Concepts

| Concept | What it is |
|---|---|
| **Workflow Definition** | A graph of nodes + connections. Stored in `workflow_definitions`. Shared with the existing n8n-style governance workflows engine but tagged `category='agent-behavior/*'` for the agent surface. |
| **Binding** | Links a workflow to an agent. Two scopes: `agent_gallery_id` (template-level default; applies to every hire) or `slot_id` (hire-time override; supersedes template default for this specific hire). |
| **Run** | Per-agent, per-binding multi-turn state. Executes one step per agent turn. Persists a `graph_snapshot` at run-start so mid-run definition edits don't disrupt in-flight execution. |
| **Dispatcher** | Per-turn orchestrator. At turn start: walks the graph from the current active-step frontier, executes non-deferred steps immediately (tool.git.*, sprint.*, condition, parallel.*), stops at deferred steps (prompt.*, acp.slash.invoke) and injects their template into the next LLM turn. |

## Node types

### Prompt family — defer to next LLM turn
- **`prompt.plan`** — "make a plan" instruction
- **`prompt.create_todo`** — schema = array of `{ title, ownerHint? }`
- **`prompt.review`** — schema = `{ approved, issues }`
- **`prompt.freeform`** — custom template via `node.parameters.promptTemplate`

### Git tool family — argv-safe subprocess
- **`tool.git.status`** — `git status --porcelain`
- **`tool.git.diff`** — `git diff [args]`
- **`tool.git.commit`** — `git commit -m <rendered>`
- **`tool.git.push`** — `git push [args]`

All use `execFile('git', argv, { shell: false })`. No shell interpolation, no command injection surface. IAM gate requires `mcp.shell.exec` in the agent's `allowedTools`.

### Sprint family — team task bridge
- **`sprint.create_task`** — calls `TaskManager.create({ teamId, subject, description?, owner? })`
- **`sprint.update_task`** — calls `TaskManager.update(taskId, { status?, owner?, progressNotes? })`
- **`sprint.list_tasks`** — calls `TaskManager.list(teamId)`

IAM-gated per-handler: `team_task_create`, `team_task_update`, `team_task_list`.

### Control flow (shared with governance engine)
- **`trigger`** — entry node; no side effect, just a graph anchor
- **`condition`** — sets `__branch = 'true' | 'false'`; downstream edges filter by `fromOutput` match
- **`loop`** — set `__loopItems` from a field

### v2.6.0 additions
- **`parallel.fan_out`** — marker that downstream edges are parallel branches
- **`parallel.join`** — waits until *all* incoming-edge sources have completed before activating
- **`human.approve`** — pauses the run with `status='paused'`; resume via `ipcBridge.agentWorkflows.resume`
- **`memory.recall`** — read-only lookup against `reasoningBank` trajectories; exposes top-K similar runs as an experience prior for a subsequent prompt step
- **`acp.slash.invoke`** — invoke an ACP runtime slash command (`/compact`, `/clear`, etc.) on the next turn

## Templating

All string-valued parameters support `{{var.X}}` substitution against the run's state bag:

```json
{
  "subject": "Fix bug in {{var.module}}"
}
```

- `var` resolves against the run's `state_json` which accumulates every completed step's output keyed by step id.
- Dotted paths work: `{{var.user.first}}`.
- Missing keys render the literal token (visible authoring aid).

## Built-in workflows (seeded at boot)

| Canonical ID | What it does |
|---|---|
| `builtin:workflow.safe_commit@1` | plan → status → diff → self-review → commit → push (guarded by review gate) |
| `builtin:workflow.pr_triage@1` | diff → review → file follow-up task |
| `builtin:workflow.sprint_standup@1` | plan → list tasks → synthesize standup → file follow-up |
| `builtin:workflow.lead_qualify@1` | extract lead fields → file qualification task |
| `builtin:workflow.content_brief@1` | plan → create todos → draft → self-review |
| `builtin:workflow.research_digest@1` | plan → create topics → write per-topic digests |
| `builtin:workflow.parallel_review@1` | memory.recall → diff → parallel (code + security review) → join → human.approve → summarize → file |

Seeds are idempotent (`canonical_id` keyed; version-gated upgrade-in-place). User forks get `source='local'` + same `canonical_id`; reseed never touches local rows.

## /agent-workflows UI

### Main page (sidebar: 🪢 Agent Workflows)

- **Left**: list of agent-behavior workflows (builtin + local + master-pushed).
- **Right top**: graph view of the selected workflow (React Flow). Drag to reposition, click to edit params, drag between handles to connect, Delete/Backspace to remove. Save / Revert / + Add node / + New workflow in the header.
- **Right bottom**: live-updating "Recent runs" panel. Status badges: running (blue), completed (green), failed (red), paused (orange). Abort button for in-flight runs.

### Node parameter drawer

Click any node in editable mode → side drawer with a monospace JSON editor for that node's `parameters`. Cmd/Ctrl+Enter applies; ESC cancels. The page tag shows **Unsaved** until the header Save button persists.

### Publish to fleet (master only)

Each local workflow detail card shows a **Publish to fleet** button. Publishing flips `published_to_fleet=1`; the next master→slave bundle poll carries the workflow to every enrolled slave as a `source='master'` row with a lock icon in the list.

## IPC surface

Renderer uses `ipcBridge.agentWorkflows.*`:

```ts
// CRUD for bindings
bind({ workflowDefinitionId, agentGalleryId?, slotId?, teamId?, expiresAt? })
unbind({ bindingId })
listBindings({ agentGalleryId?, slotId? })

// Read-only run state
getActiveRun({ slotId })
listRuns({ slotId?, teamId?, status?, limit? })

// Admin
pause({ runId })
resume({ runId })
abort({ runId })
skipStep({ runId, stepId })

// Fleet publishing
publishToFleet({ workflowId })
unpublishFromFleet({ workflowId })

// Events (emitters)
onRunStarted, onStepCompleted, onRunCompleted, onRunFailed
```

Workflow definition CRUD still rides the existing `workflow-engine.*` channels (list / get / create / update / remove).

## Dream Mode integration

Every terminal workflow run writes a trajectory into `reasoning_bank` with a `[workflow:<canonical>]`-prefixed task description. The nightly dream pass mines these alongside free-agent trajectories; Phase 4.x work will add a workflow-family distillation prompt.

## Security

Two independent gates:

1. **`agent_workflows` security feature toggle** (master kill switch). When off, the dispatcher short-circuits — no context injection, no run creation. Default: off (opt-in).
2. **IAM per-step** — `isToolAllowed(toolId, agent.allowedTools)` runs before every tool.git.* and sprint.* step. Denial fails the step with `IAM_DENIED`; routing depends on the node's `onError` (`stop` / `continue` / `retry`).

Fleet-sourced workflows (`source='master'`) are force-read-only in the UI and refuse re-broadcast via the `publishToFleet` service (anti-loop guard).

## Data model

Migration v74 adds:

- Five optional columns on `workflow_definitions` — `canonical_id`, `source`, `category`, `managed_by_version`, `published_to_fleet`. Pre-v74 rows default to `source='local'` + `published_to_fleet=0`.
- `workflow_bindings` — binding table with CHECK (`agent_gallery_id` OR `slot_id` required) + optional `expires_at` TTL.
- `agent_workflow_runs` — per-agent multi-turn state with `graph_snapshot`, `active_step_ids`, `completed_step_ids`, `failed_step_ids`, `state_json`, `trace_json` (bounded to 200 entries, oldest-first rotation).
- `agent_gallery.default_workflow_id` — template-level default for the hire-modal pre-fill.

## Files

- Service: `src/process/services/workflows/{agentBinding,agentRunState,agentDispatcher,AgentWorkflowBusyGuard,seeds,fleetPublish}.ts`
- Handlers: `src/process/services/workflows/handlers/agent/{promptHandlers,gitHandlers,sprintHandlers,extendedHandlers,index}.ts`
- IPC bridge: `src/process/bridge/agentWorkflowBridge.ts`
- Turn integration: `src/process/task/AcpAgentManager.ts` (context injection), `src/process/team/TurnFinalizer.ts` (post-turn observer)
- UI: `src/renderer/pages/agentWorkflows/{index,WorkflowGraphView,NodeParameterDrawer}.tsx`
- Tests: `tests/unit/agentWorkflows.test.ts`, `tests/integration/agentWorkflows.test.ts`

## Plan source

The feature was scoped from `glittery-enchanting-russell.md` (plan). Deferred follow-ups documented in that plan but implemented in v2.6.0: interactive graph editor, parallel.join semantics, fleet publishing, Dream Mode hook, acp.slash.invoke.

Outstanding deferred items at v2.6.0 cut:
- Dedicated git MCP server (current `child_process.execFile` is secure + stable)
- Dream Mode workflow-family distillation prompt (trajectory capture is in place; prompt engineering pending)
- Schema-aware per-handler parameter forms (JSON editor works for all 15 handlers today)
- Undo/redo stack (Save/Revert cover the common cases)
