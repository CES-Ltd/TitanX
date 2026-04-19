<p align="center">
  <img src="./docs/screenshots/titanx-logo-sm.png" alt="TitanX — Enterprise AI Agent Orchestration Platform" width="200">
</p>

<h1 align="center">TitanX</h1>

<p align="center">
  <strong>Enterprise AI Agent Orchestration Platform — Secure, Observable, Configurable ⚡</strong>
</p>

<p align="center">
  <em>Your AI Digital Workforce with enterprise-grade security, n8n-inspired workflows, LangChain agent memory, LangSmith-compatible traces, and NemoClaw network policies — all in a beautiful desktop app.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-32CD32?style=flat-square&logo=apache&logoColor=white" alt="License">
  &nbsp;
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-6C757D?style=flat-square&logo=linux&logoColor=white" alt="Platform">
  &nbsp;
  <img src="https://img.shields.io/badge/Electron-37-blue?style=flat-square&logo=electron&logoColor=white" alt="Electron">
  &nbsp;
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  &nbsp;
  <img src="https://img.shields.io/badge/SQLite-71%20migrations-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  &nbsp;
  <img src="https://img.shields.io/badge/OpenTelemetry-enabled-7B68EE?style=flat-square&logo=opentelemetry&logoColor=white" alt="OpenTelemetry">
</p>

<p align="center">
  <a href="#-key-features">Features</a> &middot;
  <a href="#-fleet-mode">Fleet Mode</a> <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha"> &middot;
  <a href="#-screenshots">Screenshots</a> &middot;
  <a href="#-security--governance">Security</a> &middot;
  <a href="#-observability">Observability</a> &middot;
  <a href="#-getting-started">Getting Started</a> &middot;
  <a href="#-tech-stack">Tech Stack</a>
</p>

---

## 🎬 Demo Videos

### App Navigation

> Home → Governance → Observability → Home

https://github.com/CES-Ltd/TitanX/raw/main/docs/screenshots/demo-navigation.mp4

### Security & Governance

> Security Features → Blueprints → Audit Log

https://github.com/CES-Ltd/TitanX/raw/main/docs/screenshots/demo-security.mp4

---

**TitanX** is an enterprise-grade desktop application for AI agent orchestration. It transforms teams of AI agents into a fully governed digital workforce with comprehensive security, observability, and compliance built-in from day one.

> Built on the open-source [AionUI](https://github.com/iOfficeAI/AionUi) platform, TitanX adds enterprise security (inspired by [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw)), workflow automation (inspired by [n8n](https://github.com/n8n-io/n8n)), agent intelligence (inspired by [LangChain](https://github.com/langchain-ai/langchain) and [DeepAgents](https://github.com/langchain-ai/deepagents)), and production observability (inspired by [LangSmith](https://github.com/langchain-ai/langsmith-sdk)) — turning a multi-agent chat interface into a complete AI company control plane.

---

## 🏗 Architecture

<p align="center">
  <img src="./docs/screenshots/titanx-architecture-v2.gif" alt="TitanX Architecture — Animated 7-layer enterprise Agent OS" width="800">
  <br/><em>Animated architecture — User → Renderer (Chat, Sprint Board, Agent Gallery, Mission Control, Observability) → IPC Bridge (66 channels + whitelist) → Team Orchestration (Lead Auto-Resume, TeammateManager, MCP Server, TaskManager + Progress Notes) → Agent OS (Hook Engine, ReasoningBank, Queen Mode, Caveman, Task Lifecycle State Machine) → Enterprise Security (IAM, Audit Log + Device Signing, Workspace Isolation, CSRF Gate, Impersonation Defense) → External APIs (Claude, Gemini, OpenCode, DeepAgents, MCP Servers) · SQLite WAL · 58 Migrations</em>
</p>

---

## 📸 Screenshots

<p align="center">
  <img src="./docs/screenshots/01-home.png" alt="TitanX Home — Multi-agent chat with 20+ LLM providers" width="700">
  <br/><em>Home — Multi-agent chat with Gemini, Claude, OpenCode, and 20+ LLM providers</em>
</p>

<p align="center">
  <img src="./docs/screenshots/04-security-features.png" alt="TitanX Security Features — 10 configurable security toggles" width="700">
  <br/><em>Security Features — 10 master toggles for NemoClaw-inspired security controls</em>
</p>

<p align="center">
  <img src="./docs/screenshots/05-workflow-engine.png" alt="TitanX Workflow Engine — n8n-inspired DAG workflow builder" width="700">
  <br/><em>Workflow Engine — n8n-inspired DAG workflow builder with triggers, conditions, approvals</em>
</p>

<p align="center">
  <img src="./docs/screenshots/06-blueprints.png" alt="TitanX Blueprints — Declarative security profiles for agents" width="700">
  <br/><em>Agent Blueprints — 4 built-in security profiles (sandboxed, developer, researcher, CI)</em>
</p>

<p align="center">
  <img src="./docs/screenshots/03-observability.png" alt="TitanX Observability — Command Center with KPIs, cost tracking, agent status" width="700">
  <br/><em>Command Center — KPIs, token usage, cost tracking, sprint progress, agent status</em>
</p>

<p align="center">
  <img src="./docs/screenshots/07-audit-log.png" alt="TitanX Audit Log — HMAC-signed immutable audit trail" width="700">
  <br/><em>Audit Log — HMAC-signed immutable audit trail for every action in the system</em>
</p>

<p align="center">
  <img src="./docs/screenshots/09-iam-policies.png" alt="TitanX IAM Policies — Granular tool permissions with templates" width="700">
  <br/><em>IAM Policies — 4 templates (Developer, Researcher, Tester, Minimal) with granular tool permissions</em>
</p>

---

## ✨ Key Features

### 🏢 Multi-Agent Team Orchestration

- **Lead agent architecture** — lead agent coordinates teammates via mailbox + task board with auto-resume on restart
- **Dynamic agent spawning** — lead can recruit specialists at runtime
- **MCP tool server** — 9 built-in team coordination tools with rate limiting (30/min) and impersonation defense
- **Multi-provider support** — Claude, GPT, Gemini, Codex, OpenCode, Hermes, Ollama, and 20+ LLM providers
- **Agent Gallery** — 34 pre-built agent templates across 7 departments (Engineering, Product, QA, DevOps, Security, Data, Operations)
- **Stable agent identity** — task ownership by agent name (not volatile slotId), survives restarts without confusion
- **Progress notes** — agents save what was done and what remains on every task update, enabling seamless resume after restart
- **Auto-re-wake** — agents with in_progress tasks automatically continue working after each turn (no manual re-delegation needed)
- **Mission Control** — real-time task timeline with blinking status indicators, team health KPIs, agent utilization bars, and live activity feed in the side pane
- **Live agent status** — green glowing dots with rotating funny phrases ("Yak-shaving...", "Neuromancing...") for active agents in the Workforce panel
- **Pixel-art office** — animated visualization of agent activity with BFS pathfinding

### 🔄 Workflow Engine (n8n-Inspired)

- **DAG execution engine** — topological sort, parallel branches, retry with backoff, error routing
- **8 node types** — trigger, action, condition (if/else with true/false branching), transform, loop, agent call, approval gate, error handler
- **Visual workflow builder** — full-width modal with node palette, inline parameter editors, connection management
- **Execution history** — full per-node input/output recording for debugging
- **Agent-triggered workflows** — agents can invoke workflows via `<trigger_workflow>` XML action

### 🧠 Agent Memory (LangChain-Inspired)

- **4 memory types** — buffer, summary, entity, long-term
- **Token-counted entries** with relevance scoring
- **Auto-pruning** at configurable token threshold (default 8K)
- **Automatic storage** — every agent turn stores buffer memory
- **Team-scoped** — memories isolated per agent per team

### 🧪 Deep Agent — AG-UI Research Engine

- **LangGraph research graph** — planner → researcher (loop) → synthesizer, runs in-process
- **13+ inline visual types** — chart (line/bar/pie/area/scatter/radar), kpi, metric grid, table, pivot, timeline, gauge, comparison, citation, plan — all rendered as interactive cards in chat
- **Smart data auto-visualization** — plain text with numbers, bullet lists, trends, percentages, and comparisons auto-detected and rendered as charts/metrics
- **Human-in-the-Loop (HITL)** — agent proposes research steps, user confirms/rejects via inline checkbox UI before execution
- **AG-UI task progress** — live step-by-step progress bar with status icons (pending/executing/completed)
- **Subgraph status** — multi-agent delegation display showing active sub-agent
- **Tool card registry** — rich visual cards for weather, web search, and URL fetch tool results
- **Dual-render pipeline** — fenced code blocks for agent-generated visuals + IPC message types for real-time interactive components
- **Dynamic connector & MCP selection** — inline chip selectors for backend providers and MCP servers
- **Insights panel** — extracted visuals displayed in a side panel for at-a-glance research overview

### 📋 Agent Planning (DeepAgents-Inspired)

- **Structured task decomposition** — ordered steps with progress tracking
- **Delegation** — steps can be delegated to subagents
- **Self-reflection** — agents rate their own output quality (0-1 score)
- **Auto-plan creation** — agents creating 2+ tasks automatically generate a plan
- **Backfill from tasks** — existing team_tasks synced to plans on startup

### 🧬 Agent OS Features

- **Agent Hook System** — 6 event types (PreToolUse, PostToolUse, Stop, etc.) with command/http/function hooks for extensible tool execution
- **ReasoningBank** — Store and replay successful execution trajectories (RETRIEVE → JUDGE → DISTILL pattern, ~32% token savings)
- **Task Lifecycle State Machine** — Enforced state transitions (queued → claimed → dispatched → running → completed/failed/cancelled) with full audit trail
- **Micro-Compaction** — Selective truncation of stale tool results to prevent context overflow without full conversation compaction
- **Queen Mode** — Hierarchical swarm coordinator role with drift detection and checkpoint gates
- **Custom Agent Definitions** — Load agent specs from `.claude/agents/` (JSON/Markdown with YAML frontmatter)
- **CLAUDE.md Chain Loading** — Walk up parent directories for project-level system prompt rules
- **Caveman Mode** — Token-saving prompt injection (Lite/Full/Ultra, 30-75% reduction) with observability tracking
- **Live Flow Visualizer** — Real-time interactive SVG graph of agent execution events with zoom/pan/click-to-inspect
- **Sprint Analytics** — Burndown charts, agent utilization, velocity tracking
- **Cost Projections** — Token usage over time, multi-provider cost estimates, caveman savings comparison
- **Chat De-Stutter** — Automatic removal of repeated phrases, malformed XML tags, and streaming artifacts from agent output
- **Database Auto-Pruning** — Periodic cleanup of stale data (activity log >30d, messages >14d inactive, done tasks >7d, unused trajectories >14d) for long-running stability

### 📊 Trace System (LangSmith-Compatible)

- **Hierarchical parent-child traces** — root runs with nested child runs
- **Token attribution** — exact input/output token counts per trace run
- **Cost tracking** — per-run cost in cents
- **OTel correlation** — trace runs linked to OpenTelemetry spans via IDs
- **User feedback** — thumbs up/down + comments on any trace run
- **6 run types** — chain, agent, tool, llm, retriever, workflow

### 📋 Sprint Board (JIRA-like)

- **Swimlane view** — Kanban board: Backlog → Todo → In Progress → Review → Done
- **List view** — sortable table with priority tags, assignee avatars, status badges
- **Auto-generated IDs** — sequential TASK-001, TASK-002 per team
- **Real-time sync** — agent task creation via MCP tools instantly appears on the board
- **Task dependencies** — block/unblock relationships with automatic cascade

---

## 🌐 Fleet Mode <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha"> <img src="https://img.shields.io/badge/enterprise-ready-4FC3F7?style=flat-square" alt="Enterprise Ready">

> ⚠️ **Alpha — v2.4.x.** The Master / Slave / Farm stack was validated end-to-end (two physical machines, hire-to-reply round-trip) but is still iterating. Expect breaking changes through the v2.x cycle: envelope fields may gain required params, command types may rename, telemetry shape may widen. Pin both master and slave to the same minor version. Production rollouts should pilot with a small slave cohort before going fleet-wide.

TitanX v2.4 ships **Fleet Mode** — a control-plane extension that lets one install coordinate many. A device boots in one of four flavors, switchable from the titlebar without editing config files:

<p align="center">
  <img src="https://img.shields.io/badge/Regular-single%20machine-6C757D?style=for-the-badge" alt="Regular">
  &nbsp;
  <img src="https://img.shields.io/badge/Master-fleet%20admin-3370FF?style=for-the-badge&logo=dependabot&logoColor=white" alt="Master">
  &nbsp;
  <img src="https://img.shields.io/badge/Slave%20%E2%80%A2%20Workforce-managed%20endpoint-00B42A?style=for-the-badge" alt="Slave Workforce">
  &nbsp;
  <img src="https://img.shields.io/badge/Slave%20%E2%80%A2%20Farm-remote%20compute-FF7D00?style=for-the-badge&logo=docker&logoColor=white" alt="Slave Farm">
</p>

### Mode matrix

| Capability                                                                                         | Regular | Master | Slave / Workforce | Slave / Farm |
| -------------------------------------------------------------------------------------------------- | :-----: | :----: | :---------------: | :----------: |
| Local teams + ACP agents                                                                           |   ✅    |   ✅   |        ✅         |      ✅      |
| Fleet webserver (enrollments, config bundles, signed commands)                                     |    —    |   ✅   |         —         |      —       |
| Push telemetry → master (60s cadence, runtime summary)                                             |    —    |   —    |        ✅         |      ✅      |
| Pull IAM / security-toggle / agent-template bundles                                                |    —    |   —    |        ✅         |      ✅      |
| Accept destructive commands (`cache.clear`, `credential.rotate`, `agent.restart`, `force.upgrade`) |    —    |   —    |        ✅         |      ✅      |
| Accept farm commands (`team.farm_provision`, `agent.execute`)                                      |    —    |   —    |         —         |      ✅      |
| Host Lead ACP session for a master-mirrored team                                                   |    —    |   —    |         —         |      ✅      |

<p align="center">
  <img src="./docs/diagrams/fleet-master-slave.gif" alt="TitanX Master / Slave fleet mode — animated architecture" width="800">
  <br/><em>Master publishes signed config bundles (IAM, templates, managed keys); slaves poll every 30s, apply, and stream telemetry + command acks back.</em>
</p>

### 🏛 Master Mode <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha">

- **Fleet Dashboard** — device roster, heartbeat freshness, enrollment tokens, revocation forensics
- **Signed command envelopes** — Ed25519 signing with replay nonces + admin re-auth for destructive tiers
- **Config bundle publishing** — IAM policies, security-feature toggles, and agent templates roll out to every slave on the next 30s poll
- **Device telemetry** — per-slave cost, activity, tool calls, policy violations, and **detected ACP runtimes** (Claude Code CLI, OpenCode, Codex, Gemini, Qwen, Goose, and 13 more — auto-refreshed when slaves push)
- **Command Center** — target-confirmation modal + admin-password gate + multi-device broadcasts
- **Farm hire modal** — editable runtime picker with green "on device" tags, runtime fallback list even before telemetry lands
- **Dream Mode** (Phase C) — nightly cross-slave learning consolidation with redaction + per-device opt-in

### 👷 Slave / Workforce <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha">

- **Managed endpoint** — slave operator sees a slim UI; IT-controlled policies lock sensitive settings with a padlock icon
- **Auto-enrollment via JWT** — device fingerprint + Ed25519 key pair bound at first enrollment, persisted encrypted
- **Heartbeat + config-sync loops** — idempotent, 5s heartbeat, 30s config poll, exponential backoff on master unreachable
- **Telemetry push** — every 60s: cost, activity, agent counts, detected ACP runtimes (no API keys, shape only)
- **Destructive command receiver** — verifies signed envelope (signature + replay nonce), executes with audit trail, acks with granular reason codes

<p align="center">
  <img src="./docs/diagrams/fleet-farm-mode.gif" alt="TitanX Agent Farm mode — animated distributed compute" width="800">
  <br/><em>Hybrid teams: the master's Team chat dispatches signed <code>agent.execute</code> envelopes to farm slaves; each slave runs a cached ACP session and streams the turn back through the mirrored mailbox.</em>
</p>

### 🚜 Slave / Farm <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha"> <img src="https://img.shields.io/badge/remote%20compute-node-FF7D00?style=flat-square" alt="Remote Compute">

_Farm mode is everything Workforce does, plus the slave acts as a remote-compute node for master's teams._

- **Hire-time mirror provisioning** — `team.farm_provision` fires the moment master clicks Hire; slave creates a mirror team with a local **Lead ACP session** (using the operator's chosen runtime) + the farm teammate, and the team shows up immediately in the slave's Teams UI
- **Persistent Lead CLI session** — 30min idle-cached ACP agent per team; multi-turn conversations preserve context without respawning the CLI every message (2–5s saved per turn)
- **17 supported ACP runtimes** — Claude Code CLI, OpenCode, Codex, Gemini, Qwen, Goose, Auggie, Kimi, OpenCode, GitHub Copilot, CodeBuddy, Factory Droid, Cursor, Kiro, iFlow, Mistral Vibe, Qoder, nanobot, Aion, DeepAgents
- **Signed `agent.execute` envelopes** — master dispatches per-turn via the same Ed25519 channel; slave routes through the cached Lead session; response flows back through the master team's mailbox exactly like a local teammate's reply
- **Slave-side Teams UI** — the mirrored team renders **read-only** on the slave (blue "Mirror of master's farm slot" badge) with live message history; slave operator can see what master's orchestration is doing without interfering
- **Mailbox round-trip** — farm teammate's reply is routed back through the team mailbox + wakes the master Lead, same loop as a local teammate using the MCP `send_message` tool
- **Defense-in-depth enrollment gate** — workforce slaves that accidentally receive a farm command fast-skip with `reason: 'not_farm_role'`

### Visual mode switcher

Switch modes without a restart: click the fleet icon in the titlebar, pick Regular / Master / Slave, paste the master URL + enrollment token if joining a fleet. Slaves can additionally flip between Workforce ↔ Farm via a second titlebar button — the role change re-enrolls automatically.

<p align="center">
  <em>See <a href="./docs/feature/fleet/README.md">docs/feature/fleet/</a> for the full operator guide: enrollment flow, command types, telemetry shape, Lead-session lifecycle, and troubleshooting by ack reason code.</em>
</p>

---

## 🌙 Dream Mode <img src="https://img.shields.io/badge/NEW-v2.5-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/self--evolving-fleet-7C3AED?style=flat-square" alt="Self-Evolving"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha">

> The fleet gets smarter on its own. Every slave's agent turns become training signal; a nightly LLM pass consolidates fleet-wide wisdom; every slave benefits on the next turn.

<p align="center">
  <img src="./docs/diagrams/dream-mode.gif" alt="TitanX Dream Mode — self-evolving fleet" width="820">
  <br/><em>Capture → push → dream → broadcast → apply. Six steps, closed loop, workspace-scoped, with per-stage failure instrumentation and exponential backoff on transient failures.</em>
</p>

- **Step 1 — Capture** · `TurnFinalizer` stamps every agent turn with `workspace_id` + `failure_pattern` flag; successful and failed trajectories both land in the local `reasoning_bank`. Step[0] carries a 1KB reasoning snippet so downstream distillation has context beyond tool names.
- **Step 2 — Push (every 2h)** · Slave builds an envelope (`trajectories`, `memorySummaries`, `consumptionFeedback`), deep-scrubs for secrets, audits for high-entropy leaks, and POSTs to master over the same JWT channel as telemetry. Exponential backoff (1×→8×) on consecutive failures.
- **Step 3 — Dream pass** · Master's nightly scheduler (03:00 local + threshold-triggered) deduplicates clusters by `(trajectoryHash, workspaceId)`, runs an LLM distillation pass (structured JSON insight: taskShape, preferredPath, avoidancePath, triggerCondition), and ranks by `score × usage × adoption`. Per-stage failure counters expose partial degradation; retry wrapper handles transient throws.
- **Step 4 — Version++** · Consolidated output writes to `consolidated_learnings` with a monotonically-bumped version + `contributing_devices` provenance.
- **Step 5 — Broadcast** · The next config bundle pull carries trajectories, memory summaries, and template persona patches. Pre-v2.5 slaves safely ignore the new fields.
- **Step 6 — Apply** · Slaves upsert consolidated trajectories into local `reasoning_bank` with `source_tag='fleet_consolidated'`; memory summaries land in `agent_memory` keyed by `agentSlotHash`; template patches merge into agent_gallery persona on the next spawn. Retrieval prefers fleet-consolidated + workspace-matching rows over locally-minted ones.

**Opt-in per device.** Admin toggles `fleet.learning.enabled` on the FleetDashboard; global kill switch lives in the secrets vault. Learning envelopes are rate-limited (500 trajectories/device/24h default) and never logged verbatim to the activity log.

---

## 🔒 Security & Governance

### Runtime IAM Policy Enforcement

- **Granular tool permissions** — multi-select checkboxes for 9 MCP tools + 7 agent actions
- **Per-tool allow/deny** — or wildcard `*` for full access
- **Agent binding** — bind policies to specific agents via multi-select dropdown
- **Filesystem access tiers** — none / read-only / workspace / full
- **Cost limits** — max cost per turn (cents) + max agent spawns
- **SSRF protection toggle** — block private IPs, DNS rebinding, cloud metadata
- **TTL-based expiration** — policies auto-expire after 1h, 24h, 7d, 30d, or permanent
- **Every tool call checked** — `evaluateToolAccess()` runs before every MCP dispatch

### Network Egress Policies (NemoClaw-Inspired)

- **Deny-by-default** — all outbound blocked unless explicitly allowed
- **11 service presets** — Telegram, Slack, Discord, Docker, HuggingFace, PyPI, npm, Brew, Jira, Outlook, GitHub
- **Rule matching** — host wildcards, port, path prefix, HTTP methods, TLS enforcement
- **Tool-scoped** — restrict which tools can access which endpoints
- **Hot-toggleable** — enable/disable without restart

### SSRF Protection

- **Private IP blocking** — RFC1918, loopback, link-local, CGNAT, IPv6 private ranges
- **URL scheme validation** — only http/https allowed
- **DNS rebinding detection** — resolves hostnames and validates all returned IPs
- **Cloud metadata blocking** — blocks `169.254.169.254` and metadata endpoints

### Agent Security Blueprints

| Blueprint               | FS Tier   | Budget | Network                   | SSRF |
| ----------------------- | --------- | ------ | ------------------------- | ---- |
| **sandboxed-default**   | read-only | $5/mo  | No egress                 | On   |
| **developer-open**      | workspace | $50/mo | GitHub, npm, Docker       | On   |
| **researcher-readonly** | read-only | $20/mo | HuggingFace, PyPI, GitHub | On   |
| **ci-headless**         | workspace | $10/mo | GitHub, Docker            | On   |

### Secrets Management (AES-256-GCM)

- **Encrypted vault** with per-secret random IVs and authentication tags
- **Policy-driven access tokens** — SHA-256 hashed, TTL-bound, timing-safe comparison
- **Session tokens** — per-agent delegated tokens with policy snapshots
- **Auto-revocation** — tokens invalidated on agent completion/failure
- **Periodic cleanup** — expired tokens purged every 60 seconds

### Comprehensive Audit Logging

- **HMAC-SHA256 signed** — every log entry tamper-detectable
- **Device Identity Signing** — Ed25519 hardware-bound key pairs for non-repudiable audit trails (per-install device fingerprint)
- **100+ action types** — security toggles, policy changes, agent lifecycle, tool calls, workflow executions
- **Real-time UI** — audit log auto-refreshes on new entries
- **Entity type filtering** — 19 entity types for precise querying
- **Color-coded actions** — green for enabled/created, red for denied/deleted, blue for disabled
- **Retention-aware pruning** — entries older than 30 days auto-pruned, recent 7 days immutable via trigger

### Workspace Isolation (Multi-Tenant)

- **Strict mode** — database-level row isolation with scoped queries
- **Soft mode** — application-level filtering for backward compatibility
- **Cross-workspace blocked** — queries crossing workspace boundaries are rejected and logged
- **Member management** — owner, admin, member, viewer roles with RBAC

### Additional Security Hardening

- **Agent Impersonation Defense** — cross-validates agent identity on task mutations (only task owner or lead can modify)
- **IPC Channel Whitelist** — preload bridge validates all IPC channels, rejects unknown channels
- **CSRF Content-Type Gate** — requires `application/json` for all mutation requests, forces CORS preflight
- **TCP Socket Hardening** — 30s idle timeout, 10MB buffer cap, socket.destroy() on timeout
- **Heap Management** — 4GB max heap, periodic manual GC every 30 minutes

---

## 📊 Observability

### Command Center Dashboard

- **KPI strip** — Teams, Agents, Runs, Spend, Incidents at a glance
- **Token usage** — by agent + by team with cost breakdown
- **Sprint progress** — per-team completion rates
- **Budget health** — utilization gauge with incident alerts
- **Activity stream** — live audit trail

### OpenTelemetry Integration

- **Configurable exporters** — OTLP (HTTP/gRPC), Console, or disabled
- **Span instrumentation** — agent turns, MCP tool calls, workflow executions
- **Metrics** — counters for tool calls, turns, policy evaluations, feature toggles
- **Histograms** — tool call duration tracking
- **Settings UI** — toggle traces/metrics, set endpoint, sample rate, log level

### Cost Tracking & Budgets

- **Per-agent cost tracking** — input/output tokens, estimated costs
- **Per-provider breakdown** — cost by LLM provider and model
- **Budget policies** — global, per-agent-type limits with auto-pause
- **Budget incidents** — alerts with resolve/dismiss workflow

---

## 🎮 Easter Eggs & Fun Features

| Easter Egg          | How to Trigger                        |
| ------------------- | ------------------------------------- |
| **Konami Code**     | ↑↑↓↓←→←→BA on keyboard                |
| **Matrix Mode**     | Triple-click the TitanX logo          |
| **Retro Terminal**  | Type `/retro` in chat                 |
| **AI Haiku**        | Type `/haiku` in chat                 |
| **Rap Battle**      | Type `/rapbattle` in chat             |
| **Agent Mood Ring** | 5 rapid clicks on agent element       |
| **Secret Stats**    | Shift+click About section 3x          |
| **Bollywood Mode**  | Click the easter egg icon in titlebar |

### Desktop Pet (5 Themes)

🟣 Default · 🐱 Cat · 🧙 Wizard · 🤖 Robot · 🥷 Ninja — with comic speech bubbles, idle chatter, and AI-aware animations.

---

## 🌍 Internationalization

**10 languages**: 🇺🇸 English · 🇨🇳 简体中文 · 🇹🇼 繁體中文 · 🇯🇵 日本語 · 🇰🇷 한국어 · 🇪🇸 Español · 🇫🇷 Français · 🇮🇹 Italiano · 🇮🇳 हिन्दी · 🇹🇷 Türkçe

---

## 🛠 Tech Stack

| Layer                  | Technology                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Desktop**            | Electron 37                                                                                          |
| **Frontend**           | React 19, TypeScript (strict), Arco Design, UnoCSS                                                   |
| **Database**           | SQLite (better-sqlite3) with WAL mode, **71 migrations**, auto-pruning                               |
| **Fleet Mode**         | Master / Slave / Farm modes; Ed25519-signed commands; 60s telemetry push; runtime-aware hire modal   |
| **IPC**                | Custom bridge pattern (`@office-ai/platform`) — 66 IPC channels + whitelist                          |
| **Security**           | AES-256-GCM, SHA-256 tokens, HMAC-SHA256 + Ed25519 device signatures, workspace isolation, CSRF gate |
| **Observability**      | OpenTelemetry (OTLP/Console), LangSmith-compatible traces                                            |
| **AI Providers**       | 20+ LLM providers (Claude, GPT, Gemini, Codex, OpenCode, Hermes, Ollama, etc.)                       |
| **Workflow Engine**    | n8n-inspired DAG execution with topological sort, retry, error routing                               |
| **Agent Intelligence** | LangChain memory, DeepAgents planning, reflection, structured output                                 |
| **Deep Agent**         | LangGraph JS, AG-UI protocol, Chart.js inline visuals, HITL, smart data detection                    |
| **Testing**            | Vitest 4, 310+ test files, 80% coverage target                                                       |
| **Package Manager**    | Bun                                                                                                  |

---

## 🚀 Getting Started

```bash
# Clone
git clone https://github.com/CES-Ltd/TitanX.git
cd TitanX

# Install dependencies
bun install

# Rebuild native modules for Electron
bun run postinstall

# Start in development mode
bun start

# Build for production
bun run dist:mac    # macOS
bun run dist:win    # Windows
bun run dist:linux  # Linux
```

---

## 📁 Project Structure

```
TitanX/
├── src/
│   ├── renderer/               # React UI (Electron window)
│   │   ├── pages/
│   │   │   ├── governance/     # IAM, Workflows, Security, Blueprints, Traces, Audit
│   │   │   ├── observability/  # Command Center, Cost Analytics, Runtime
│   │   │   ├── team/           # Team Chat, Sprint, Gallery, Live, Planner
│   │   │   ├── conversation/   # Chat messages, markdown, tool calls
│   │   │   └── deepAgent/     # AG-UI research engine with inline visuals
│   │   └── components/         # Shared UI + Easter Eggs
│   ├── process/                # Main process (backend)
│   │   ├── services/
│   │   │   ├── policyEnforcement/  # Runtime IAM decision point
│   │   │   ├── networkPolicy/      # Deny-by-default egress + 11 presets
│   │   │   ├── ssrfProtection/     # IP/DNS/scheme validation
│   │   │   ├── blueprints/         # Declarative security profiles
│   │   │   ├── workspace/          # Multi-tenant workspace isolation
│   │   │   ├── deviceIdentity/     # Ed25519 hardware-bound key pairs
│   │   │   ├── taskLifecycle/      # Task state machine + transitions
│   │   │   ├── agentMemory/        # LangChain-inspired memory
│   │   │   ├── agentPlanning/      # DeepAgents-inspired planning
│   │   │   ├── reasoningBank/      # Trajectory storage + replay
│   │   │   ├── hooks/              # Agent hook system (Pre/PostToolUse)
│   │   │   ├── caveman/            # Token-saving Caveman Mode
│   │   │   ├── deepAgent/          # LangGraph research graph + AG-UI protocol
│   │   │   ├── tracing/            # LangSmith-compatible traces
│   │   │   ├── workflows/          # n8n-inspired DAG engine
│   │   │   ├── telemetry/          # OpenTelemetry SDK
│   │   │   ├── secrets/            # AES-256-GCM vault
│   │   │   ├── activityLog/        # HMAC + Ed25519 signed audit trail
│   │   │   └── database/pruning    # Auto-pruning for long-running stability
│   │   ├── bridge/             # 30+ IPC handler files
│   │   └── team/               # Team orchestration engine
│   └── common/                 # Shared types, IPC bridge definitions
├── docs/screenshots/           # Application screenshots
└── resources/                  # App icons, logos
```

---

## Database Schema

TitanX adds **40+ tables** via **71 migrations** on top of AionUI's base schema:

| Category                                                                                                                                                                                                              | Tables                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Security**                                                                                                                                                                                                          | iam_policies, agent_policy_bindings, credential_access_tokens, agent_session_tokens, network_policies, network_policy_rules, security_feature_toggles, agent_blueprints                                                      |
| **Multi-Tenant**                                                                                                                                                                                                      | workspaces, workspace_members                                                                                                                                                                                                |
| **Workflows**                                                                                                                                                                                                         | workflow_definitions, workflow_executions, workflow_node_executions                                                                                                                                                          |
| **Intelligence**                                                                                                                                                                                                      | agent_memory, agent_plans, reasoning_bank, caveman_savings                                                                                                                                                                   |
| **Traces**                                                                                                                                                                                                            | trace_runs, trace_feedback                                                                                                                                                                                                   |
| **Operations**                                                                                                                                                                                                        | activity_log (HMAC + device signed), secrets, secret_versions, cost_events, budget_policies, budget_incidents, agent_runs, approvals, workflow_rules                                                                         |
| **Teams**                                                                                                                                                                                                             | teams, team_tasks (with progress_notes + lifecycle_state), sprint_tasks, sprint_counters, agent_gallery, agent_snapshots, inference_routing_rules, project_plans                                                             |
| **Fleet** <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW"> <img src="https://img.shields.io/badge/status-Alpha-FFB020?style=flat-square&logo=semver&logoColor=white" alt="Alpha"> | fleet_enrollments, fleet_config_version, fleet_telemetry_reports, fleet_telemetry_state, fleet_commands, fleet_command_acks, fleet_farm_devices, fleet_agent_jobs, fleet_learnings, consolidated_learnings, learning_exports |

---

## 🔑 Keywords

`ai-agents` `multi-agent-orchestration` `enterprise-security` `agent-os` `iam` `rbac` `audit-logging` `device-identity` `workspace-isolation` `opentelemetry` `langchain` `langsmith` `n8n-workflows` `nemoclaw` `electron-app` `react` `typescript` `sqlite` `desktop-app` `ai-governance` `llm-orchestration` `agent-memory` `agent-planning` `reasoning-bank` `caveman-mode` `network-policies` `ssrf-protection` `workflow-automation` `sprint-board` `cost-tracking` `mission-control` `auto-pruning` `fleet-mode` `master-slave` `agent-farm` `acp-runtime` `distributed-agents` `signed-commands`

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

---

## Attribution

<p align="center">
  TitanX is built on <a href="https://github.com/iOfficeAI/AionUi"><strong>AionUI</strong></a> — the open-source AI cowork platform by <a href="https://www.aionui.com">iOfficeAI</a>.
  <br/>
  We gratefully acknowledge the AionUI team for their foundational work that makes TitanX possible.
  <br/><br/>
  Security patterns inspired by <a href="https://github.com/NVIDIA/NemoClaw">NVIDIA NemoClaw</a> · Workflows inspired by <a href="https://github.com/n8n-io/n8n">n8n</a> · Agent intelligence inspired by <a href="https://github.com/langchain-ai/langchain">LangChain</a> & <a href="https://github.com/langchain-ai/deepagents">DeepAgents</a> · Observability inspired by <a href="https://github.com/langchain-ai/langsmith-sdk">LangSmith</a> · Chat UI patterns inspired by <a href="https://github.com/CopilotKit/CopilotKit">CopilotKit</a>
</p>

---

<p align="center">
  <img src="./resources/ces-logo.png" alt="CES Ltd" width="120">
  <br/>
  <strong>CES Ltd</strong>
  <br/>
  <a href="https://cesltd.com">cesltd.com</a> · <a href="https://github.com/CES-Ltd">GitHub</a>
</p>
