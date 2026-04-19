/**
 * @license Apache-2.0
 * farmProvisioning — slave-side handler for `team.farm_provision`
 * commands (v2.4.0).
 *
 * Fired by the master the moment an operator hires a farm teammate,
 * BEFORE any `agent.execute` flows. The slave pre-materializes the
 * mirror team so it shows up in the slave's Teams UI immediately:
 *
 *   - If the team row doesn't exist: create it, plus a local Lead
 *     ACP conversation + a Lead agent slot. The Lead becomes the
 *     durable entry point for all subsequent master→slave messages
 *     for this team (the routing half lands in v2.5.x).
 *   - If the team already exists (second hire, same teamId): skip
 *     the Lead + just append the farm teammate to the existing
 *     agents[] array.
 *   - Either way, register the farm teammate as a `type: 'farm'`
 *     conversation row so it has somewhere to hold message history
 *     when the dispatch path later targets it directly.
 *
 * Everything is idempotent on (teamId, agentSlotId). A master retry
 * (replay nonce rejected mid-flight) lands as a no-op beyond timestamp
 * bumps — the slave never ends up with duplicate Lead or duplicate
 * teammate rows.
 */

import { uuid } from '@/common/utils';
import { getDatabase } from '@process/services/database';
import { logActivity } from '@process/services/activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import { ProcessConfig } from '@process/utils/initStorage';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';
import type { AckStatus } from './types';

/**
 * v2.4.2 — only farm-role slaves accept farm provisioning / execution
 * commands. A workforce slave (or an un-enrolled machine in some
 * misconfigured split-brain) receiving `team.farm_provision` or
 * `agent.execute` silently building up mirror teams it can't actually
 * serve would be a boundary violation, even if not a security one
 * (signed envelope already verified). Fast rejection keeps the slave's
 * state clean and surfaces a clear ack reason to master audit.
 */
async function isFarmRoleEnrolled(): Promise<boolean> {
  try {
    const raw = (await ProcessConfig.get('fleet.enrollmentRole')) as string | undefined;
    return raw === 'farm';
  } catch (e) {
    logNonCritical('fleet.farm-provision.role-check', e);
    return false;
  }
}

export type HandlerOutcome = {
  status: AckStatus;
  result?: Record<string, unknown>;
};

/** Envelope-body shape for `team.farm_provision`. */
type ProvisionParams = {
  teamId: string;
  teamName: string;
  /** Runtime to seed the slave Lead with. Falls back to the teammate's runtime when omitted. */
  leadRuntimeBackend?: string;
  agentSlotId: string;
  agentName: string;
  remoteSlotId: string;
  runtimeBackend: string;
  toolsAllowlist?: string[];
};

function parseParams(raw: Record<string, unknown>): ProvisionParams | null {
  const teamId = typeof raw.teamId === 'string' ? raw.teamId : '';
  const teamName = typeof raw.teamName === 'string' ? raw.teamName : '';
  const agentSlotId = typeof raw.agentSlotId === 'string' ? raw.agentSlotId : '';
  const agentName = typeof raw.agentName === 'string' ? raw.agentName : '';
  const remoteSlotId = typeof raw.remoteSlotId === 'string' ? raw.remoteSlotId : '';
  const runtimeBackend = typeof raw.runtimeBackend === 'string' ? raw.runtimeBackend : '';
  if (!teamId || !teamName || !agentSlotId || !agentName || !remoteSlotId || !runtimeBackend) return null;
  return {
    teamId,
    teamName,
    leadRuntimeBackend: typeof raw.leadRuntimeBackend === 'string' ? raw.leadRuntimeBackend : undefined,
    agentSlotId,
    agentName,
    remoteSlotId,
    runtimeBackend,
    toolsAllowlist: Array.isArray(raw.toolsAllowlist)
      ? (raw.toolsAllowlist as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
  };
}

type SlaveTeamAgent = {
  slotId: string;
  conversationId: string;
  role: 'lead' | 'teammate';
  agentType: string;
  agentName: string;
  conversationType: string;
  status: 'pending' | 'idle' | 'active' | 'completed' | 'failed';
  agentGalleryId?: string;
  backend?: 'local' | 'farm';
  fleetBinding?: {
    deviceId: string;
    remoteSlotId: string;
    toolsAllowlist: string[];
    runtimeBackend?: string;
  };
};

function loadTeamAgents(db: ISqliteDriver, teamId: string): SlaveTeamAgent[] {
  try {
    const row = db.prepare('SELECT agents FROM teams WHERE id = ?').get(teamId) as { agents: string } | undefined;
    if (!row) return [];
    const parsed = JSON.parse(row.agents) as SlaveTeamAgent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logNonCritical('fleet.farm-provision.load-agents', e);
    return [];
  }
}

/**
 * Create the slave Lead's local conversation + agent slot. The Lead
 * runs a real ACP CLI on the slave (same runtime as the first farm
 * hire, by default) so the slave operator can drop into it
 * interactively too — not just as a passive mirror.
 *
 * Returns the new agent slot for the caller to append to teams.agents.
 */
function createLeadSlot(db: ISqliteDriver, params: ProvisionParams): SlaveTeamAgent {
  const leadSlotId = `slot-lead-${uuid(8)}`;
  const leadConversationId = `farm-lead-${uuid(16)}`;
  const leadRuntime = params.leadRuntimeBackend ?? params.runtimeBackend;
  const now = Date.now();

  // Lead's local conversation (type='acp'). Empty workspace → initAgent
  // spins up a temp dir when the CLI session first boots.
  try {
    db.prepare(
      `INSERT INTO conversations (id, user_id, name, type, extra, status, created_at, updated_at)
       VALUES (?, 'system_default_user', ?, 'acp', ?, 'pending', ?, ?)`
    ).run(
      leadConversationId,
      `${params.teamName} Lead`,
      JSON.stringify({
        backend: leadRuntime,
        workspace: '',
        // Lets the team UI distinguish fleet-mirror Leads from
        // user-created ACP conversations in drill-down views.
        teamId: params.teamId,
        isFleetMirrorLead: true,
      }),
      now,
      now
    );
  } catch (e) {
    logNonCritical('fleet.farm-provision.create-lead-conv', e);
  }

  return {
    slotId: leadSlotId,
    conversationId: leadConversationId,
    role: 'lead',
    agentType: leadRuntime,
    agentName: `${params.teamName} Lead`,
    conversationType: 'acp',
    status: 'idle',
    backend: 'local',
  };
}

function createTeammateSlot(params: ProvisionParams): { slot: SlaveTeamAgent; conversationId: string } {
  // Mirror farm conversation id. Stable per (agentSlotId) so a replay
  // hits the same row.
  const conversationId = `farm-mirror-${params.agentSlotId}`;
  return {
    conversationId,
    slot: {
      slotId: params.agentSlotId,
      conversationId,
      role: 'teammate',
      agentType: params.runtimeBackend,
      agentName: params.agentName,
      conversationType: 'farm',
      status: 'idle',
      agentGalleryId: params.remoteSlotId,
      backend: 'farm',
      fleetBinding: {
        deviceId: 'self',
        remoteSlotId: params.remoteSlotId,
        toolsAllowlist: params.toolsAllowlist ?? [],
        runtimeBackend: params.runtimeBackend,
      },
    },
  };
}

/**
 * Main handler. Returns a HandlerOutcome the slave executor serializes
 * into the ack. Never throws — provisioning failures land as
 * `status: 'failed'` with a reason code so the master's adapter can
 * surface it to the operator.
 */
export async function handleTeamFarmProvision(rawParams: Record<string, unknown>): Promise<HandlerOutcome> {
  const parsed = parseParams(rawParams);
  if (!parsed) {
    return { status: 'skipped', result: { reason: 'invalid_params' } };
  }

  // v2.4.2 — enrollmentRole gate. A workforce slave shouldn't be
  // materializing farm mirror teams.
  if (!(await isFarmRoleEnrolled())) {
    return { status: 'skipped', result: { reason: 'not_farm_role' } };
  }

  const db = await getDatabase();
  const driver = db.getDriver();

  const existingTeam = driver.prepare('SELECT id, name FROM teams WHERE id = ?').get(parsed.teamId) as
    | { id: string; name: string }
    | undefined;

  const existingAgents = existingTeam ? loadTeamAgents(driver, parsed.teamId) : [];

  // Has this exact teammate slot already been provisioned (replay /
  // duplicate hire)? Return success with a `duplicate` marker so the
  // master's ack handler knows this wasn't a fresh provision.
  if (existingAgents.some((a) => a.slotId === parsed.agentSlotId)) {
    return {
      status: 'succeeded',
      result: {
        reason: 'duplicate',
        teamId: parsed.teamId,
        agentSlotId: parsed.agentSlotId,
      },
    };
  }

  const teammate = createTeammateSlot(parsed);
  let leadSlot: SlaveTeamAgent | null = null;
  const now = Date.now();

  if (!existingTeam) {
    // Fresh team — create the Lead first, then the teams row + stash
    // both agents.
    leadSlot = createLeadSlot(driver, parsed);
    try {
      driver
        .prepare(
          `INSERT INTO teams (id, user_id, name, workspace, workspace_mode, lead_agent_id, agents, created_at, updated_at)
           VALUES (?, 'system_default_user', ?, '', 'shared', ?, ?, ?, ?)`
        )
        .run(
          parsed.teamId,
          parsed.teamName,
          leadSlot.slotId,
          JSON.stringify([leadSlot, teammate.slot]),
          now,
          now
        );
    } catch (e) {
      logNonCritical('fleet.farm-provision.create-team', e);
      return {
        status: 'failed',
        result: { reason: 'team_create_failed', error: e instanceof Error ? e.message : String(e) },
      };
    }
  } else {
    // Team exists — skip Lead creation, append the teammate.
    const nextAgents = [...existingAgents, teammate.slot];
    try {
      driver
        .prepare('UPDATE teams SET name = ?, agents = ?, updated_at = ? WHERE id = ?')
        .run(parsed.teamName, JSON.stringify(nextAgents), now, parsed.teamId);
    } catch (e) {
      logNonCritical('fleet.farm-provision.update-team-agents', e);
      return {
        status: 'failed',
        result: { reason: 'team_update_failed', error: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  // Teammate's farm conversation — holds the mirrored message history
  // once agent.execute turns land. Idempotent via INSERT OR IGNORE.
  try {
    driver
      .prepare(
        `INSERT OR IGNORE INTO conversations (id, user_id, name, type, extra, status, created_at, updated_at)
         VALUES (?, 'system_default_user', ?, 'farm', ?, 'finished', ?, ?)`
      )
      .run(
        teammate.conversationId,
        parsed.agentName,
        JSON.stringify({
          deviceId: 'self',
          remoteSlotId: parsed.remoteSlotId,
          teamId: parsed.teamId,
          agentSlotId: parsed.agentSlotId,
          toolsAllowlist: parsed.toolsAllowlist ?? [],
          isSlaveMirror: true,
        }),
        now,
        now
      );
  } catch (e) {
    logNonCritical('fleet.farm-provision.create-farm-conv', e);
  }

  try {
    logActivity(driver, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_farm_provision',
      action: 'fleet.farm.provisioned',
      entityType: 'team',
      entityId: parsed.teamId,
      details: {
        teamName: parsed.teamName,
        agentSlotId: parsed.agentSlotId,
        agentName: parsed.agentName,
        runtimeBackend: parsed.runtimeBackend,
        leadCreated: !existingTeam,
        leadRuntimeBackend: leadSlot?.agentType,
      },
      agentId: parsed.agentSlotId,
    });
  } catch (e) {
    logNonCritical('fleet.farm-provision.audit', e);
  }

  return {
    status: 'succeeded',
    result: {
      teamId: parsed.teamId,
      agentSlotId: parsed.agentSlotId,
      leadSlotId: leadSlot?.slotId,
      leadConversationId: leadSlot?.conversationId,
      leadCreated: !existingTeam,
    },
  };
}
