<p align="center">
  <img src="./resources/titanx-logo.png" alt="TitanX — Enterprise AI Agent Orchestration Platform" width="200">
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
  <img src="https://img.shields.io/badge/SQLite-47%20migrations-003B57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite">
  &nbsp;
  <img src="https://img.shields.io/badge/OpenTelemetry-enabled-7B68EE?style=flat-square&logo=opentelemetry&logoColor=white" alt="OpenTelemetry">
</p>

<p align="center">
  <a href="#-key-features">Features</a> &middot;
  <a href="#-screenshots">Screenshots</a> &middot;
  <a href="#-security--governance">Security</a> &middot;
  <a href="#-observability">Observability</a> &middot;
  <a href="#-getting-started">Getting Started</a> &middot;
  <a href="#-tech-stack">Tech Stack</a>
</p>

---

## 🎬 Demo Videos

| Video | Duration | What it shows |
|-------|----------|---------------|
| [App Navigation](./docs/screenshots/demo-navigation.mp4) | 8s | Home → Governance → Observability → Home |
| [Security & Governance](./docs/screenshots/demo-security.mp4) | 8s | Security Features → Blueprints → Audit Log |

> **Tip:** Clone the repo and open `docs/screenshots/demo-*.mp4` locally, or view on GitHub by clicking the links above.

---

**TitanX** is an enterprise-grade desktop application for AI agent orchestration. It transforms teams of AI agents into a fully governed digital workforce with comprehensive security, observability, and compliance built-in from day one.

> Built on the open-source [AionUI](https://github.com/iOfficeAI/AionUi) platform, TitanX adds enterprise security (inspired by [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw)), workflow automation (inspired by [n8n](https://github.com/n8n-io/n8n)), agent intelligence (inspired by [LangChain](https://github.com/langchain-ai/langchain) and [DeepAgents](https://github.com/langchain-ai/deepagents)), and production observability (inspired by [LangSmith](https://github.com/langchain-ai/langsmith-sdk)) — turning a multi-agent chat interface into a complete AI company control plane.

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

---

## ✨ Key Features

### 🏢 Multi-Agent Team Orchestration

- **Lead agent architecture** — lead agent coordinates teammates via mailbox + task board
- **Dynamic agent spawning** — lead can recruit specialists at runtime
- **MCP tool server** — 9 built-in team coordination tools with rate limiting (30/min)
- **Multi-provider support** — Claude, GPT, Gemini, Codex, OpenCode, Hermes, Ollama, and 20+ LLM providers
- **Agent Gallery** — 8 pre-seeded templates (Developer, QA, Research, DevOps, Security, Writer, Frontend, Data)
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

### 📋 Agent Planning (DeepAgents-Inspired)

- **Structured task decomposition** — ordered steps with progress tracking
- **Delegation** — steps can be delegated to subagents
- **Self-reflection** — agents rate their own output quality (0-1 score)
- **Auto-plan creation** — agents creating 2+ tasks automatically generate a plan
- **Backfill from tasks** — existing team_tasks synced to plans on startup

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

| Blueprint | FS Tier | Budget | Network | SSRF |
|-----------|---------|--------|---------|------|
| **sandboxed-default** | read-only | $5/mo | No egress | On |
| **developer-open** | workspace | $50/mo | GitHub, npm, Docker | On |
| **researcher-readonly** | read-only | $20/mo | HuggingFace, PyPI, GitHub | On |
| **ci-headless** | workspace | $10/mo | GitHub, Docker | On |

### Secrets Management (AES-256-GCM)

- **Encrypted vault** with per-secret random IVs and authentication tags
- **Policy-driven access tokens** — SHA-256 hashed, TTL-bound, timing-safe comparison
- **Session tokens** — per-agent delegated tokens with policy snapshots
- **Auto-revocation** — tokens invalidated on agent completion/failure
- **Periodic cleanup** — expired tokens purged every 60 seconds

### Comprehensive Audit Logging

- **HMAC-SHA256 signed** — every log entry tamper-detectable
- **100+ action types** — security toggles, policy changes, agent lifecycle, tool calls, workflow executions
- **Real-time UI** — audit log auto-refreshes on new entries
- **Entity type filtering** — 19 entity types for precise querying
- **Color-coded actions** — green for enabled/created, red for denied/deleted, blue for disabled

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

| Easter Egg | How to Trigger |
|------------|---------------|
| **Konami Code** | ↑↑↓↓←→←→BA on keyboard |
| **Matrix Mode** | Triple-click the TitanX logo |
| **Retro Terminal** | Type `/retro` in chat |
| **AI Haiku** | Type `/haiku` in chat |
| **Rap Battle** | Type `/rapbattle` in chat |
| **Agent Mood Ring** | 5 rapid clicks on agent element |
| **Secret Stats** | Shift+click About section 3x |
| **Bollywood Mode** | Click the easter egg icon in titlebar |

### Desktop Pet (5 Themes)

🟣 Default · 🐱 Cat · 🧙 Wizard · 🤖 Robot · 🥷 Ninja — with comic speech bubbles, idle chatter, and AI-aware animations.

---

## 🌍 Internationalization

**10 languages**: 🇺🇸 English · 🇨🇳 简体中文 · 🇹🇼 繁體中文 · 🇯🇵 日本語 · 🇰🇷 한국어 · 🇪🇸 Español · 🇫🇷 Français · 🇮🇹 Italiano · 🇮🇳 हिन्दी · 🇹🇷 Türkçe

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop** | Electron 37 |
| **Frontend** | React 19, TypeScript (strict), Arco Design, UnoCSS |
| **Database** | SQLite (better-sqlite3) with WAL mode, **47 migrations** |
| **IPC** | Custom bridge pattern (`@office-ai/platform`) — 60+ IPC channels |
| **Security** | AES-256-GCM, SHA-256 tokens, HMAC-SHA256 audit signatures, timing-safe comparison |
| **Observability** | OpenTelemetry (OTLP/Console), LangSmith-compatible traces |
| **AI Providers** | 20+ LLM providers (Claude, GPT, Gemini, Codex, OpenCode, Hermes, Ollama, etc.) |
| **Workflow Engine** | n8n-inspired DAG execution with topological sort, retry, error routing |
| **Agent Intelligence** | LangChain memory, DeepAgents planning, reflection, structured output |
| **Testing** | Vitest 4, 310+ test files, 80% coverage target |
| **Package Manager** | Bun |

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
│   │   │   └── conversation/   # Chat messages, markdown, tool calls
│   │   └── components/         # Shared UI + Easter Eggs
│   ├── process/                # Main process (backend)
│   │   ├── services/
│   │   │   ├── policyEnforcement/  # Runtime IAM decision point
│   │   │   ├── networkPolicy/      # Deny-by-default egress + 11 presets
│   │   │   ├── ssrfProtection/     # IP/DNS/scheme validation
│   │   │   ├── blueprints/         # Declarative security profiles
│   │   │   ├── agentMemory/        # LangChain-inspired memory
│   │   │   ├── agentPlanning/      # DeepAgents-inspired planning
│   │   │   ├── tracing/            # LangSmith-compatible traces
│   │   │   ├── workflows/          # n8n-inspired DAG engine
│   │   │   ├── telemetry/          # OpenTelemetry SDK
│   │   │   ├── secrets/            # AES-256-GCM vault
│   │   │   └── activityLog/        # HMAC-signed audit trail
│   │   ├── bridge/             # 30+ IPC handler files
│   │   └── team/               # Team orchestration engine
│   └── common/                 # Shared types, IPC bridge definitions
├── docs/screenshots/           # Application screenshots
└── resources/                  # App icons, logos
```

---

## Database Schema

TitanX adds **30+ tables** via **47 migrations** on top of AionUI's base schema:

| Category | Tables |
|----------|--------|
| **Security** | iam_policies, agent_policy_bindings, credential_access_tokens, agent_session_tokens, network_policies, network_policy_rules, security_feature_toggles, agent_blueprints |
| **Workflows** | workflow_definitions, workflow_executions, workflow_node_executions |
| **Intelligence** | agent_memory, agent_plans |
| **Traces** | trace_runs, trace_feedback |
| **Operations** | activity_log, secrets, secret_versions, cost_events, budget_policies, budget_incidents, agent_runs, approvals, workflow_rules |
| **Teams** | teams, sprint_tasks, sprint_counters, agent_gallery, agent_snapshots, inference_routing_rules, project_plans |

---

## 🔑 Keywords

`ai-agents` `multi-agent-orchestration` `enterprise-security` `iam` `rbac` `audit-logging` `opentelemetry` `langchain` `langsmith` `n8n-workflows` `nemoclaw` `electron-app` `react` `typescript` `sqlite` `desktop-app` `ai-governance` `llm-orchestration` `agent-memory` `agent-planning` `network-policies` `ssrf-protection` `workflow-automation` `sprint-board` `cost-tracking`

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
