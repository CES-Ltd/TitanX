/**
 * @license Apache-2.0
 * Agent sandbox — filesystem path validation, action allowlist, budget enforcement.
 * Prevents rogue agents from accessing files outside workspace or exceeding budget.
 */

import path from 'path';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

/** Paths that agents must NEVER access regardless of policy */
const BLOCKED_PATHS = [
  '/.ssh/',
  '/.aws/',
  '/.env',
  '/.gnupg/',
  '/.config/gcloud/',
  '/titanx-secrets/',
  '/master.key',
  '/.git/config',
  '/credentials',
  '/id_rsa',
  '/id_ed25519',
];

/** Sensitive filename patterns */
const SENSITIVE_PATTERNS = [/\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.jks$/i, /\.keystore$/i];

/**
 * Validate that a file path is within the allowed workspace boundary.
 * Returns true if the path is safe, false if it should be blocked.
 */
export function isPathAllowed(filePath: string, workspacePath: string): boolean {
  if (!filePath || !workspacePath) return false;

  // Resolve to absolute paths (handles ../ traversal)
  const resolved = path.resolve(filePath);
  const workspace = path.resolve(workspacePath);

  // Must be within workspace
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    return false;
  }

  // Check blocked paths
  const normalizedPath = resolved.toLowerCase();
  for (const blocked of BLOCKED_PATHS) {
    if (normalizedPath.includes(blocked.toLowerCase())) {
      return false;
    }
  }

  // Check sensitive file patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(resolved)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if an agent's tool call is allowed by its gallery allowedTools list.
 * Returns true if allowed, false if blocked.
 */
export function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  // Empty allowlist = all tools allowed (backward compatible)
  if (allowedTools.length === 0) return true;
  // Wildcard = all allowed
  if (allowedTools.includes('*')) return true;
  // Exact match
  return allowedTools.includes(toolName);
}

/**
 * Check if an agent has exceeded its budget.
 * Returns the overage amount in cents (0 = within budget, >0 = exceeded).
 */
export function checkAgentBudget(
  db: ISqliteDriver,
  agentType: string,
  maxBudgetCents: number | undefined
): { exceeded: boolean; spentCents: number; limitCents: number } {
  if (!maxBudgetCents || maxBudgetCents <= 0) {
    return { exceeded: false, spentCents: 0, limitCents: 0 };
  }

  const row = db
    .prepare(
      'SELECT CAST(COALESCE(SUM(cost_cents), 0) AS INTEGER) as total FROM cost_events WHERE agent_type = ? AND occurred_at >= ?'
    )
    .get(agentType, getMonthStart()) as { total: number };

  return {
    exceeded: row.total > maxBudgetCents,
    spentCents: row.total,
    limitCents: maxBudgetCents,
  };
}

/**
 * Scan text for potential credential leaks.
 * Returns array of detected credential patterns.
 */
export function detectCredentialLeaks(text: string): string[] {
  const detections: string[] = [];

  const patterns: Array<[string, RegExp]> = [
    ['API Key', /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi],
    ['Bearer Token', /Bearer\s+[a-zA-Z0-9_\-.]{20,}/gi],
    ['AWS Key', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
    ['Private Key', /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g],
    ['GitHub Token', /gh[ps]_[a-zA-Z0-9]{36}/g],
    ['Slack Token', /xox[bpors]-[a-zA-Z0-9\-]{10,}/g],
    ['JWT', /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g],
    ['Password Assignment', /(?:password|passwd|pwd)\s*[:=]\s*['"](?!.*\*)[^'"]{8,}['"]/gi],
  ];

  for (const [label, regex] of patterns) {
    if (regex.test(text)) {
      detections.push(label);
    }
  }

  return detections;
}

function getMonthStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}
