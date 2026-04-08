/**
 * @license Apache-2.0
 * Network egress policy engine — deny-by-default outbound network control.
 * Inspired by NVIDIA NemoClaw's network policy layer.
 * Agents can only access endpoints explicitly allowed by policy rules.
 */

import crypto from 'crypto';
import { URL } from 'url';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { validateUrl } from '../ssrfProtection';
import type { PolicyDecision } from '../policyEnforcement';
import { getPreset } from './presets';

// ── Types ────────────────────────────────────────────────────────────────────

export type NetworkPolicy = {
  id: string;
  userId: string;
  name: string;
  agentGalleryId?: string;
  rules: NetworkRule[];
  enabled: boolean;
  createdAt: number;
};

export type NetworkRule = {
  id: string;
  policyId: string;
  host: string;
  port?: number;
  pathPrefix?: string;
  methods?: string[];
  tlsRequired: boolean;
  toolScope?: string[];
  sortOrder: number;
};

type CreatePolicyInput = {
  userId: string;
  name: string;
  agentGalleryId?: string;
  rules: Array<Omit<NetworkRule, 'id' | 'policyId' | 'sortOrder'>>;
};

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createPolicy(db: ISqliteDriver, input: CreatePolicyInput): NetworkPolicy {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    'INSERT INTO network_policies (id, user_id, name, agent_gallery_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(id, input.userId, input.name, input.agentGalleryId ?? null, now);

  const rules: NetworkRule[] = input.rules.map((r, i) => {
    const ruleId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO network_policy_rules (id, policy_id, host, port, path_prefix, methods, tls_required, tool_scope, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ruleId,
      id,
      r.host,
      r.port ?? null,
      r.pathPrefix ?? null,
      r.methods ? JSON.stringify(r.methods) : null,
      r.tlsRequired ? 1 : 0,
      r.toolScope ? JSON.stringify(r.toolScope) : null,
      i
    );
    return { ...r, id: ruleId, policyId: id, sortOrder: i };
  });

  logActivity(db, {
    userId: input.userId,
    actorType: 'user',
    actorId: input.userId,
    action: 'network_policy.created',
    entityType: 'network_policy',
    entityId: id,
    details: { name: input.name, ruleCount: rules.length, agentGalleryId: input.agentGalleryId },
  });

  return {
    id,
    userId: input.userId,
    name: input.name,
    agentGalleryId: input.agentGalleryId,
    rules,
    enabled: true,
    createdAt: now,
  };
}

export function listPolicies(db: ISqliteDriver, userId: string): NetworkPolicy[] {
  const rows = db
    .prepare('SELECT * FROM network_policies WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const rules = db
      .prepare('SELECT * FROM network_policy_rules WHERE policy_id = ? ORDER BY sort_order ASC')
      .all(r.id as string) as Array<Record<string, unknown>>;

    return {
      id: r.id as string,
      userId: r.user_id as string,
      name: r.name as string,
      agentGalleryId: (r.agent_gallery_id as string) ?? undefined,
      enabled: (r.enabled as number) === 1,
      createdAt: r.created_at as number,
      rules: rules.map(rowToRule),
    };
  });
}

export function deletePolicy(db: ISqliteDriver, policyId: string): boolean {
  // Rules cascade-deleted via foreign key
  return db.prepare('DELETE FROM network_policies WHERE id = ?').run(policyId).changes > 0;
}

export function togglePolicy(db: ISqliteDriver, policyId: string, enabled: boolean): void {
  db.prepare('UPDATE network_policies SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, policyId);
}

/**
 * Apply a named preset as a new network policy for an agent or globally.
 */
export function applyPreset(
  db: ISqliteDriver,
  userId: string,
  presetName: string,
  agentGalleryId?: string
): NetworkPolicy | null {
  const preset = getPreset(presetName);
  if (!preset) return null;

  return createPolicy(db, {
    userId,
    name: `${preset.name} (preset)`,
    agentGalleryId,
    rules: preset.rules.map((r) => ({
      host: r.host,
      port: r.port,
      pathPrefix: r.pathPrefix,
      methods: r.methods,
      tlsRequired: r.tlsRequired,
    })),
  });
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Evaluate whether an agent is allowed to access a URL.
 * Runs SSRF check first, then matches against bound network policies.
 * Deny-by-default: if policies exist but none match, access is denied.
 */
export function evaluateNetworkAccess(
  db: ISqliteDriver,
  url: string,
  method: string,
  agentGalleryId?: string,
  toolName?: string
): PolicyDecision {
  // SSRF check first
  const ssrfResult = validateUrl(url);
  if (!ssrfResult.safe) {
    return {
      allowed: false,
      reason: ssrfResult.reason ?? 'SSRF blocked',
      decision: 'deny',
      toolName,
      agentSlotId: agentGalleryId,
    };
  }

  // Parse URL for matching
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}`, decision: 'deny', toolName };
  }

  // Find applicable policies (agent-specific + global)
  const agentPolicies = agentGalleryId
    ? (db
        .prepare('SELECT * FROM network_policies WHERE agent_gallery_id = ? AND enabled = 1')
        .all(agentGalleryId) as Array<Record<string, unknown>>)
    : [];

  const globalPolicies = db
    .prepare('SELECT * FROM network_policies WHERE agent_gallery_id IS NULL AND enabled = 1')
    .all() as Array<Record<string, unknown>>;

  const allPolicies = [...agentPolicies, ...globalPolicies];

  // No policies = allow (backward compatible, no enforcement)
  if (allPolicies.length === 0) {
    return {
      allowed: true,
      reason: 'No network policies configured — default allow',
      decision: 'no_policy',
      toolName,
    };
  }

  // Check each policy's rules for a match
  for (const policy of allPolicies) {
    const rules = db
      .prepare('SELECT * FROM network_policy_rules WHERE policy_id = ? ORDER BY sort_order ASC')
      .all(policy.id as string) as Array<Record<string, unknown>>;

    for (const ruleRow of rules) {
      const rule = rowToRule(ruleRow);
      if (matchesRule(parsed, method, toolName, rule)) {
        // TLS enforcement
        if (rule.tlsRequired && parsed.protocol !== 'https:') {
          return {
            allowed: false,
            reason: `TLS required for ${rule.host} but URL uses ${parsed.protocol}`,
            decision: 'deny',
            policyId: policy.id as string,
            toolName,
          };
        }

        return {
          allowed: true,
          reason: `Allowed by policy "${policy.name}" rule for ${rule.host}`,
          decision: 'allow',
          policyId: policy.id as string,
          toolName,
        };
      }
    }
  }

  // Policies exist but no rule matches — deny by default
  return {
    allowed: false,
    reason: `No network policy rule allows access to ${parsed.hostname}${parsed.pathname}`,
    decision: 'deny',
    toolName,
  };
}

// ── Rule matching ────────────────────────────────────────────────────────────

function matchesRule(parsed: URL, method: string, toolName: string | undefined, rule: NetworkRule): boolean {
  // Host matching (supports wildcard prefix like *.github.com)
  if (!matchHost(parsed.hostname, rule.host)) return false;

  // Port matching
  if (rule.port) {
    const urlPort = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
    if (urlPort !== rule.port) return false;
  }

  // Path prefix matching
  if (rule.pathPrefix && !parsed.pathname.startsWith(rule.pathPrefix)) return false;

  // Method matching
  if (rule.methods && rule.methods.length > 0) {
    if (!rule.methods.includes(method.toUpperCase())) return false;
  }

  // Tool scope matching
  if (rule.toolScope && rule.toolScope.length > 0 && toolName) {
    if (!rule.toolScope.includes(toolName)) return false;
  }

  return true;
}

function matchHost(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".github.com"
    return hostname.endsWith(suffix) || hostname === pattern.slice(2);
  }
  return hostname === pattern;
}

function rowToRule(row: Record<string, unknown>): NetworkRule {
  return {
    id: row.id as string,
    policyId: row.policy_id as string,
    host: row.host as string,
    port: (row.port as number) ?? undefined,
    pathPrefix: (row.path_prefix as string) ?? undefined,
    methods: row.methods ? JSON.parse(row.methods as string) : undefined,
    tlsRequired: (row.tls_required as number) === 1,
    toolScope: row.tool_scope ? JSON.parse(row.tool_scope as string) : undefined,
    sortOrder: (row.sort_order as number) ?? 0,
  };
}
