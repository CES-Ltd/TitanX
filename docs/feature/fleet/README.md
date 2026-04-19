# Fleet Mode — Operator Guide

<p align="center">
  <img src="https://img.shields.io/badge/NEW-v2.4-FF6B6B?style=flat-square" alt="NEW">
  &nbsp;
  <img src="https://img.shields.io/badge/Status-validated%20end--to--end-00B42A?style=flat-square" alt="Validated">
  &nbsp;
  <img src="https://img.shields.io/badge/Enterprise-ready-4FC3F7?style=flat-square" alt="Enterprise Ready">
</p>

Fleet Mode turns TitanX from a single-machine app into a control-plane that coordinates many. One machine runs as **Master**, any number run as **Slaves** (in one of two flavors — Workforce or Farm), and they exchange signed commands, config bundles, and telemetry over a small HTTP surface.

This guide covers:

1. [Mode matrix](#1-mode-matrix)
2. [Switching modes](#2-switching-modes)
3. [Enrollment flow](#3-enrollment-flow)
4. [Master mode](#4-master-mode)
5. [Slave / Workforce](#5-slave--workforce)
6. [Slave / Farm](#6-slave--farm)
7. [Command types](#7-command-types)
8. [Telemetry shape](#8-telemetry-shape)
9. [Troubleshooting by ack reason code](#9-troubleshooting-by-ack-reason-code)

---

## 1. Mode matrix

<p align="center">
  <img src="https://img.shields.io/badge/Regular-single%20machine-6C757D?style=for-the-badge" alt="Regular">
  &nbsp;
  <img src="https://img.shields.io/badge/Master-fleet%20admin-3370FF?style=for-the-badge" alt="Master">
  &nbsp;
  <img src="https://img.shields.io/badge/Slave%20%E2%80%A2%20Workforce-managed%20endpoint-00B42A?style=for-the-badge" alt="Slave Workforce">
  &nbsp;
  <img src="https://img.shields.io/badge/Slave%20%E2%80%A2%20Farm-remote%20compute-FF7D00?style=for-the-badge" alt="Slave Farm">
</p>

| Capability | Regular | Master | Slave / Workforce | Slave / Farm |
|---|:---:|:---:|:---:|:---:|
| Local teams + ACP agents | ✅ | ✅ | ✅ | ✅ |
| Fleet webserver (enrollments, config bundles, signed commands) | — | ✅ | — | — |
| Push telemetry → master (60s cadence, runtime summary) | — | — | ✅ | ✅ |
| Pull IAM / security-toggle / agent-template bundles | — | — | ✅ | ✅ |
| Accept destructive commands (`cache.clear`, `credential.rotate`, `agent.restart`, `force.upgrade`) | — | — | ✅ | ✅ |
| Accept farm commands (`team.farm_provision`, `agent.execute`) | — | — | — | ✅ |
| Host persistent Lead ACP session for a master-mirrored team | — | — | — | ✅ |

---

## 2. Switching modes

Click the **fleet icon in the titlebar** (to the right of the caveman switch). A popover appears with a Radio.Group for Regular / Master / Slave.

- **→ Master:** pick a port (default 8888) and whether to bind all interfaces (LAN exposure) vs localhost-only (single-box testing). Save & restart.
- **→ Slave:** paste the master URL (e.g. `https://10.0.0.195:8888`) + the one-time enrollment token your admin gave you. Save & restart.
- **Role switch (slaves only):** a second titlebar button (next to the fleet switcher) lets slaves flip between **Workforce** and **Farm**. Flipping clears the device JWT and re-enrolls with the new role — the master sees a new row under the fresh role.

Mode + role are persisted in `ProcessConfig`:

- `fleet.mode` — `'regular' | 'master' | 'slave'`
- `fleet.enrollmentRole` — `'workforce' | 'farm'` (slave-only, defaults to workforce)

Both are locked-at-restart: a mode change triggers `application.restart` so the router + sidebar gating rebuild cleanly.

---

## 3. Enrollment flow

Slaves enroll **once** per install. The handshake is short:

1. Master admin generates a one-time token in **Fleet Dashboard → Enrollments → New Token** (TTL configurable, 24h default).
2. Slave operator pastes the token + master URL in the titlebar mode switcher, saves.
3. On boot, the slave generates an Ed25519 keypair locally and POSTs `/api/fleet/enroll` with `{ publicKey, fingerprint, hostname, osVersion, role }`.
4. Master verifies the token, persists the slave's public key, issues a device JWT, records the enrollment with role.
5. Slave caches the JWT encrypted (AES-256-GCM, key is install-bound), starts heartbeat + config-sync + telemetry-push loops.

After enrollment the slave only needs the JWT — no more tokens. Token rotation / device revocation happens master-side and the next heartbeat fails cleanly with 401.

---

## 4. Master mode

### What it runs

- Fleet webserver on the chosen port (default 8888)
- Signed-command signing keys (Ed25519, generated on first boot)
- Fleet Dashboard UI — device roster, telemetry, command history, template library, farm dashboard

### Key UI surfaces

- **Fleet Dashboard → Devices** — enrolled slaves with last heartbeat, OS, TitanX version, enrollment role
- **Fleet Dashboard → Templates** — agent templates, publish/unpublish to fleet; bumps `fleet_config_version`
- **Fleet Dashboard → Command Center** — multi-select device targeting, destructive + non-destructive command enqueue
- **Fleet Dashboard → Farm Dashboard** — per-slave job stats, latency distribution, in-flight job inspection
- **Hire Farm Agent modal** — editable runtime picker with green "on device" tags from the latest telemetry push

### What it signs

Every signed command carries:

- `commandId` (uuid) — replay nonce
- `commandType` — one of the command types in §7
- `params` (JSON) — command-specific payload
- `targetDeviceId` — specific slave
- `issuedAt` — epoch ms
- **Ed25519 signature** over the canonical serialization

Destructive commands (§7) additionally require the admin to re-auth with their password before enqueue.

---

## 5. Slave / Workforce

### Loops

| Loop | Cadence | Purpose |
|---|---|---|
| Heartbeat | 5s | liveness, drain pending commands, advance connection status |
| Config sync | 30s | pull latest bundle (IAM policies, security toggles, agent templates) |
| Telemetry push | 60s | post cost, activity, tool-calls, policy violations, detected runtimes |
| Learning push (opt-in) | 24h | slave → master learning export for Dream Mode consolidation |

### What it accepts

- `force_config_sync` — re-pull immediately
- `force_telemetry_push` — push telemetry immediately
- `cache.clear`, `credential.rotate`, `agent.restart`, `force.upgrade` — destructive; signed + admin-authorized

### What it rejects

- `team.farm_provision`, `agent.execute` — fast-skipped with `reason: 'not_farm_role'` (v2.4.2 defense-in-depth; workforce slaves shouldn't be materializing farm teams)

### Managed config keys

After a config bundle is applied, any IAM policy / security toggle / template that was master-managed gets a padlock icon in the slave UI — a local edit attempt returns `FleetManagedKeyError` and is audit-logged. The admin clears the padlock master-side via `unpublish`.

---

## 6. Slave / Farm

### How it differs from Workforce

Farm mode is **Workforce + two new command types + a persistent Lead-session cache per team**.

### Hire flow (operator's view)

1. Master admin opens Hire Farm Agent modal
2. Picks a farm-role device from the dropdown
3. Sees detected runtimes on that device with green "on device" tags (from telemetry; fallback list shown when telemetry hasn't landed)
4. Picks a template, picks a runtime (editable — overrides the template's default agentType), clicks Hire
5. Master enqueues `team.farm_provision` — the slave materializes the mirror team + Lead conversation + farm teammate slot
6. Mirror team **shows up on the slave's Teams UI immediately** (not lazily on first message)

### Per-turn flow

1. Master Lead delegates to the farm teammate (mailbox write + wake)
2. Master's `WakeRunner.dispatchFarmTurn` builds an `AgentMessage[]` from mailbox content
3. Master enqueues `agent.execute` with `{ jobId, agentTemplateId, messages, runtimeBackend, teamId, teamName, agentSlotId, agentName, toolsAllowlist, timeoutMs }`
4. Slave verifies signed envelope, parses params
5. **Lead session lookup** — `resolveTeamLead` finds the team's Lead by `teams.lead_agent_id` → `slot.conversationId` (must be `type: 'acp'`)
6. **Get-or-start Lead CLI** — `getOrStartLeadSession`:
   - If cached: reset 30min idle teardown timer, reuse
   - Else: `acpDetector.getDetectedAgents()` → resolve `cliPath` + `acpArgs`, spawn CLI in `/tmp/titanx-farm-lead-<teamId>`, cache
7. **Run turn** — `runTurnOnLead` synthesizes the prompt via `buildAcpPrompt` (system messages → preamble, earlier turns → transcript, latest user message → active request), sends, accumulates `content` stream events, resolves on `finish` signal
8. Slave acks `{ status: 'succeeded', result: { assistantText, runtimeBackend, leadConversationId, path: 'lead' } }`
9. Master's `WakeRunner` writes the assistant text to the farm conversation + **writes mailbox entry addressed to whoever delegated** (usually Lead) + wakes the recipient — so the Lead processes the reply on its next turn, exactly like a local teammate's `send_message` would

### Slave-side Teams UI

The mirror team renders **read-only** with a blue "Mirror of master's farm slot (read-only)" badge:

- `FarmChat` detects `isSlaveMirror: true` in the conversation extras OR `fleet.getMode() === 'slave'`
- Hides the `SendBox` — slave operator can't initiate farm turns
- Still renders full message history + live updates via `responseStream` subscription

### Session lifecycle

- **Spawn:** first `agent.execute` for a teamId (or after cache eviction)
- **Teardown:** 30min idle OR CLI dies mid-turn (`runtime_error` / `runtime_send_failed` evict the cache so next turn re-spawns fresh)
- **Workspace:** `/tmp/titanx-farm-lead-<teamId>` — removed on teardown

---

## 7. Command types

| Command | Tier | Admin re-auth | Destructive? | Who sends | Slave behavior |
|---|---|:---:|:---:|---|---|
| `force_config_sync` | Non-destructive | — | — | Any user | Re-pull bundle immediately |
| `force_telemetry_push` | Non-destructive | — | — | Any user | Push telemetry immediately |
| `cache.clear` | Destructive | ✅ | ✅ | Admin | Clear local caches |
| `credential.rotate` | Destructive | ✅ | ✅ | Admin | Rotate device JWT + master keys |
| `agent.restart` | Destructive | ✅ | ✅ | Admin | Restart named team |
| `force.upgrade` | Destructive | ✅ | ✅ | Admin | Download signed installer, relaunch |
| `agent.execute` | Signed non-destructive | — | — | Farm hire | Run one turn on slave Lead (farm only) |
| `team.farm_provision` | Signed non-destructive | — | — | Farm hire | Create mirror team + Lead + teammate (farm only) |

---

## 8. Telemetry shape

Every 60s each slave POSTs `/api/fleet/telemetry` with:

```jsonc
{
  "windowStart": 1745001600000,
  "windowEnd": 1745001660000,
  "totalCostCents": 7,
  "activityCount": 12,
  "toolCallCount": 4,
  "policyViolationCount": 0,
  "agentCount": 5,
  "topActions": [
    { "action": "agent.wake", "count": 3 },
    { "action": "cost_event.record", "count": 2 }
  ],
  // v2.2.1 — detected ACP runtimes (NO API keys, shape only)
  "runtimes": [
    { "backend": "claude",   "name": "Claude Code",  "cliAvailable": true },
    { "backend": "opencode", "name": "OpenCode",     "cliAvailable": true },
    { "backend": "gemini",   "name": "Gemini CLI",   "cliAvailable": true }
  ]
}
```

`runtimes` is optional for backward compatibility — pre-v2.2.1 slaves omit it and the master renders "Runtime status unknown" in the hire modal.

Master persists in `fleet_telemetry_reports` keyed by `(device_id, window_end)`. `getLatestRuntimesByDevice` powers the hire modal's runtime badges via a batched latest-per-device query. Master emits `fleet.telemetryReceived` IPC event on every successful ingest → hire modal's SWR cache revalidates without waiting for the 30s poll tick.

---

## 9. Troubleshooting by ack reason code

| `reason` | Surface | Likely cause | Fix |
|---|---|---|---|
| `not_farm_role` | `team.farm_provision` / `agent.execute` ack | Slave is enrolled as workforce | Slave flips role in titlebar; re-enrolls as farm |
| `invalid_params` | any | Master sent a malformed envelope body | Check master's build version — upgrade to v2.3.0+ |
| `template_not_found` | `agent.execute` | Farm template isn't synced on this slave | Publish template from master's Template Library; wait for next config poll (≤30s) |
| `no_provider_configured` | `agent.execute` (legacy path) | Slave on v2.2.x with no LLM API provider and no ACP runtime picked | Upgrade slave to v2.3.0+; pick an ACP runtime at hire |
| `runtime_not_detected` | `agent.execute` (ACP path) | Operator chose a backend the slave doesn't have installed | Install the CLI on that slave and restart TitanX (ACP detector runs at boot) |
| `runtime_start_failed` | `agent.execute` | CLI spawn threw — auth, missing config, bad path, CLI killed | Check slave's log (e.g. `~/Library/Logs/TitanX/*.log`); run the CLI interactively there once (`claude`, `opencode`, etc.) to clear any first-run prompts |
| `runtime_send_failed` | `agent.execute` | CLI rejected the prompt after connect | Usually transient — the Lead session is evicted so next turn re-spawns |
| `runtime_workspace_failed` | `agent.execute` | Couldn't create `/tmp/titanx-farm-lead-<teamId>` | Check disk space / permissions on `/tmp` |
| `runtime_timeout` | `agent.execute` | CLI didn't signal `finish` within `timeoutMs` | Long-running prompts need `timeoutMs` bump on the envelope (default 120s); or the CLI hung — evicted, next turn fresh |
| `runtime_busy` | `agent.execute` | Previous turn still running (shouldn't happen — master serializes) | Master-side serialization bug; file issue |
| `runtime_error` | `agent.execute` | CLI emitted ACP protocol `error` signal | Inspect slave's farm mirror conversation — includes the error reason inline |

---

## Related

- **Internal plan:** `~/.claude/plans/glittery-enchanting-russell.md` — full v1.9.40 → v2.4.x delivery plan for Fleet + Farm + Dream Mode
- **Architecture:** [`docs/tech/architecture.md`](../../tech/architecture.md) — top-level process / IPC / database architecture
- **Team orchestration:** [`docs/tech/team.md`](../../tech/team.md) — how Lead / teammates / mailbox / MCP server interact (the same model Fleet Mode extends)
- **ACP detection:** [`docs/tech/acp-detector.md`](../../tech/acp-detector.md) — how `acpDetector` probes for Claude Code CLI, OpenCode, Codex, etc. at boot
