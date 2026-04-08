<p align="center">
  <img src="./resources/titanx-logo.png" alt="TitanX" width="200">
</p>

<h1 align="center">TitanX</h1>

<p align="center">
  <strong>Your AI Digital Workforce — Go 10X with Lightning-Fast Agent Teams ⚡</strong>
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
</p>

---

**TitanX** is a powerful enterprise-grade desktop application designed to enhance your productivity and streamline your workflow — keeping enterprise security in mind. It transforms teams of AI agents into a fully orchestrated digital workforce with governance, observability, and compliance built-in from day one.

> Built on the open-source [AionUI](https://github.com/iOfficeAI/AionUi) platform, TitanX adds enterprise security, team orchestration, SDLC workflow management, and comprehensive observability — turning a multi-agent chat interface into a complete AI company control plane.

---

## What Makes TitanX Different

While AionUI provides the foundational multi-agent desktop experience (20+ LLM providers, MCP support, conversation management), **TitanX adds an entire enterprise orchestration layer on top**:

### 🏢 Command Center & Team Management

| Feature | Description |
|---------|-------------|
| **Team Command Center** | Lead-agent-only chat with spawned agent output cards — not a horizontal scroll of all agents |
| **Workforce Panel** | Right-side pane showing org hierarchy with live status indicators for every agent |
| **Agent Team Live** | Dedicated full-page view of all spawned agents with real-time streaming status |
| **Organization View** | Canvas-rendered org hierarchy tree for every team — lead → teammates with connecting lines |
| **Modern Header Nav** | Pill-style navigation bar: Sprint \| Gallery \| Live \| Planner \| Governance \| Observability |

### 📋 Agent Sprint Board (JIRA-like)

| Feature | Description |
|---------|-------------|
| **Swimlane View** | Kanban board with drag-drop across columns: Backlog → Todo → In Progress → Review → Done |
| **List View** | Sortable table with priority tags, assignee avatars, status badges |
| **Auto-generated IDs** | Tasks get sequential IDs (TASK-001, TASK-002) per team |
| **@ Mention Chatter** | Tag agents in task comments with `@agentName` to trigger their attention |
| **Task Dependencies** | Block/unblock relationships between tasks with automatic cascade |
| **Real-time Sync** | Agent task creation via MCP tools automatically appears in Sprint Board |

### 👥 Agent Gallery & Templates

| Feature | Description |
|---------|-------------|
| **8 Pre-seeded Agent Templates** | Senior Developer, QA Engineer, Research Analyst, DevOps Engineer, Security Auditor, Technical Writer, Frontend Specialist, Data Engineer |
| **AGENTS.md / Skills / Heartbeat** | Each template includes instruction markdown, skills definition, and heartbeat protocol |
| **Hire Me Button** | One-click agent recruitment with team/provider/model selection |
| **Whitelisting** | Only published, whitelisted agents can be recruited into teams |
| **Budget Caps** | Per-session budget limits on each gallery agent |

### 📅 Project Planner

| Feature | Description |
|---------|-------------|
| **Calendar Views** | Day, Week, Month, Year views for project scheduling |
| **Plan → Sprint Bridge** | Plans automatically create sprint tasks at scheduled times |
| **Recurrence** | Daily, weekly, monthly recurring plans |
| **Color-coded Events** | Visual project tracking on the calendar |

---

## 🔒 Enterprise Security & Governance

TitanX was designed with enterprise organizations in mind. Every feature includes security, governance, and compliance considerations.

### Secrets Management (AES-256-GCM)

- **Encrypted vault** for API keys, tokens, credentials
- **AES-256-GCM encryption** with per-secret random IVs and authentication tags
- **Master key** stored with restricted permissions (`0o600`)
- **Secret versioning** with full rotation history
- **Secret references** in agent configurations — never store plaintext credentials

### IAM Policies & Access Control

- **Role-based access** with policy templates (Developer, Researcher, Tester, Read-Only)
- **Agent-to-credential binding** — specify which agents can access which credentials
- **Timed access keys** — auto-expiring tokens (1h, 24h, 7d, 30d)
- **Policy-driven credential access** — agents must pass policy check to get time-limited tokens
- **SHA-256 hashed tokens** — raw tokens never stored, only hashes
- **Access audit trail** — every credential access logged with actor, policy, and timestamp

### Credential Access Flow

```
Agent needs credential → Policy check (agent + credential match)
    → Issue time-limited token (TTL from policy)
    → Token hashed (SHA-256) and stored
    → Agent resolves credential via token
    → Access logged to audit trail
    → Token auto-expires after TTL
```

### Workflow Management

- **Approval workflows** — require human approval before sensitive actions
- **Escalation workflows** — auto-escalate stalled tasks after timeout
- **SLA policies** — response/resolution time targets per task priority
- **Configurable triggers** — event-based rules with customizable thresholds

### GitHub Integration (Device Flow)

- **One-click GitHub login** via OAuth Device Flow
- **Secure token storage** in encrypted secrets vault
- **Credential categories** — LLM providers, VCS, Cloud, Custom

---

## 📊 Observability & Analytics

### Command Center Dashboard

A single-screen info-at-a-glance view combining:

- **KPI Strip** — Teams, Agents, Runs, Spend, Active Incidents
- **Token Usage by Agent** — Input/Output tokens, cost per agent type
- **Token Usage by Team** — Aggregated token consumption per team
- **Agent Status Grid** — Active, Idle, Pending, Failed, Completed counts
- **Sprint Progress** — Per-team progress bars with task completion rates
- **Spend Trend** — Rolling 5h/24h/7d cost windows
- **Budget Health** — Utilization gauge with incident alerts
- **Pending Approvals** — Queue with type and requester
- **Workflow Rules** — Count by type (approval/escalation/SLA)
- **Recent Activity** — Live audit trail with relative timestamps

### Cost Tracking & Budgets

- **Per-agent cost tracking** — input/output tokens, estimated costs
- **Per-provider breakdown** — cost by LLM provider and model
- **Budget policies** — global, per-agent-type, per-provider limits
- **Auto-pause on overage** — agents paused when budget exceeded
- **Budget incidents** — alerts with resolve/dismiss workflow

### Comprehensive Audit Logging

Every significant event is captured in the immutable audit trail:

- `agent.status.active` / `agent.status.idle` / `agent.status.failed`
- `agent.turn_completed` — with token estimates and action counts
- `task.created` / `task.updated` — sprint task lifecycle
- `secret.created` / `credential.accessed` — security events
- `approval.approved` / `approval.rejected` — governance decisions

---

## 🎮 Easter Eggs & Fun Features

### Desktop Pet (5 Themes)

An animated companion that lives on your desktop:

| Theme | Character |
|-------|-----------|
| 🟣 **Default** | Round blob with orange hat |
| 🐱 **Cat** | Orange body, pointed ears, whiskers |
| 🧙 **Wizard** | Purple robe, blue hat, golden stars |
| 🤖 **Robot** | Boxy gray, blue LED antenna |
| 🥷 **Ninja** | Dark body, red bandana, masked face |

- **Comic speech bubbles** with funny thinking phrases on every click
- **Random idle speech** every 20-50 seconds
- **AI-aware states** — thinking, working, happy, error animations
- **Bollywood Mode** 🎬 — toggle replaces thinking phrases with iconic Hindi meme dialogues

### Pixel-Art Office

- **32×24 tile office** with warm brown wood floors and blue-gray breakout areas
- **Real character sprites** from JIK-A-4 Metro City pack (6 unique characters)
- **BFS pathfinding** — idle agents wander to breakout area, visit coffee machines
- **Chat bubbles** — agents greet each other with "Hi! 👋" when passing nearby
- **Funny idle messages** — "Need more coffee ☕", "Tokens go brrr...", "404: Motivation not found"

### Thinking Spinner Phrases

95+ tech phrases + 29 Bollywood dialogues shown while agents process:
- Normal mode: *"Yak-shaving"*, *"Docker-containerizing"*, *"Nat-twentying"*
- Bollywood mode: *"Mogambo khush hua! 🎬"*, *"Kitne aadmi the? 🤔"*, *"All izz well 🙆"*

---

## 🌍 Internationalization

**10 languages** with country flag emoji selector:

| Flag | Language | Flag | Language |
|------|----------|------|----------|
| 🇺🇸 | English | 🇪🇸 | Español |
| 🇨🇳 | 简体中文 | 🇫🇷 | Français |
| 🇹🇼 | 繁體中文 | 🇮🇹 | Italiano |
| 🇯🇵 | 日本語 | 🇮🇳 | हिन्दी |
| 🇰🇷 | 한국어 | 🇹🇷 | Türkçe |

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Desktop** | Electron 37 |
| **Frontend** | React 19, TypeScript (strict), Arco Design, UnoCSS |
| **Database** | SQLite (better-sqlite3) with WAL mode, 31 migrations |
| **IPC** | Custom bridge pattern (`@office-ai/platform`) |
| **Security** | AES-256-GCM encryption, SHA-256 token hashing, bcrypt passwords |
| **Auth** | JWT tokens, CSRF protection, rate limiting |
| **AI Providers** | 20+ LLM providers (Claude, GPT, Gemini, Codex, OpenCode, Hermes, etc.) |
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
│   ├── renderer/           # React UI (Electron window)
│   │   ├── pages/          # Page components
│   │   │   ├── governance/ # Workflows, Credentials, IAM, Audit
│   │   │   ├── observability/ # Command Center, Cost, Runtime
│   │   │   └── team/       # Team, Sprint, Gallery, Live, Planner
│   │   ├── components/     # Shared UI components
│   │   └── services/       # i18n (10 locales), hooks
│   ├── process/            # Main process (backend)
│   │   ├── services/       # Core services
│   │   │   ├── secrets/    # AES-256-GCM encryption
│   │   │   ├── costTracking/ # Token usage, budgets
│   │   │   ├── agentGallery/ # Templates, whitelisting
│   │   │   ├── credentialAccess/ # Policy-driven access tokens
│   │   │   └── ...
│   │   ├── bridge/         # 20+ IPC handlers
│   │   └── team/           # Team orchestration engine
│   └── common/             # Shared types, config
├── public/
│   ├── pet-states/         # Default pet SVG animations
│   └── pet-themes/         # Cat, Wizard, Robot, Ninja themes
└── resources/              # App icons, logos
```

---

## Database Schema

TitanX adds **13 tables** on top of AionUI's base schema (migrations v23–v31):

| Table | Purpose |
|-------|---------|
| `activity_log` | Immutable audit trail |
| `secrets` / `secret_versions` | Encrypted secrets vault |
| `cost_events` | Token usage and spend ledger |
| `budget_policies` / `budget_incidents` | Budget enforcement |
| `agent_runs` | Agent execution history |
| `approvals` | Governance approval workflows |
| `sprint_tasks` / `sprint_counters` | JIRA-like sprint board |
| `agent_gallery` | Agent templates and whitelisting |
| `workflow_rules` | Approval, escalation, SLA rules |
| `iam_policies` / `agent_policy_bindings` | Role-based access control |
| `credential_access_tokens` | Time-limited credential access |
| `project_plans` | Calendar-based project scheduling |

---

## What TitanX Adds vs AionUI

| Category | AionUI (Base) | TitanX (Enterprise) |
|----------|---------------|---------------------|
| **Agent Management** | Side-by-side chat windows | Command center with lead-only chat + workforce panel |
| **Task Tracking** | Basic team_tasks table | Full JIRA-like sprint board with swimlane/list views |
| **Security** | Base64 credential encoding | AES-256-GCM vault + IAM policies + time-limited tokens |
| **Observability** | Console logging | Command center dashboard + cost tracking + audit trail |
| **Governance** | None | Approval workflows + escalation rules + SLA policies |
| **Planning** | Cron scheduler | Calendar-based project planner with sprint integration |
| **Agent Templates** | Manual agent creation | Gallery with 8 pre-seeded templates + Hire Me button |
| **Internationalization** | 6 languages | 10 languages with flag emoji selector |
| **Desktop Pet** | 1 default character | 5 themed characters with comic speech bubbles |
| **Office Visualization** | None | Pixel-art office with BFS pathfinding + chat bubbles |
| **CLI Support** | Claude + Codex only | Claude + Codex + Gemini + OpenCode + Hermes |

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
  AionUI provides the core multi-agent desktop experience including 20+ LLM provider support, MCP integration, conversation management, extension system, channel integrations, and the Desktop Pet feature.
</p>

---

<p align="center">
  <img src="./resources/ces-logo.png" alt="CES Ltd" width="120">
  <br/>
  <strong>CES Ltd</strong>
  <br/>
  <a href="https://cesltd.com">cesltd.com</a> · <a href="https://github.com/CES-Ltd">GitHub</a>
</p>
