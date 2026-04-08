/**
 * @license Apache-2.0
 * Managed inference routing — centralized provider selection and credential injection.
 * Inspired by NVIDIA NemoClaw's managed inference gateway.
 * Routes agent inference calls through a policy-enforced point with provider fallback.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan, getCounter } from '../telemetry';

// ── Types ────────────────────────────────────────────────────────────────────

export type InferenceRoute = {
  id: string;
  agentGalleryId?: string;
  preferredProvider: string;
  fallbackProviders: string[];
  allowedModels: string[];
  maxTokensPerRequest?: number;
  credentialInjection: boolean;
  rateLimitPerMinute?: number;
  createdAt: number;
};

type CreateRouteInput = {
  agentGalleryId?: string;
  preferredProvider: string;
  fallbackProviders?: string[];
  allowedModels?: string[];
  maxTokensPerRequest?: number;
  credentialInjection?: boolean;
  rateLimitPerMinute?: number;
};

export type InferenceDecision = {
  provider: string;
  model: string;
  allowed: boolean;
  reason: string;
  routeId?: string;
};

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function createRoute(db: ISqliteDriver, input: CreateRouteInput): InferenceRoute {
  const id = crypto.randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO inference_routing_rules (id, agent_gallery_id, preferred_provider, fallback_providers, allowed_models, max_tokens_per_request, credential_injection, rate_limit_per_minute, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.agentGalleryId ?? null,
    input.preferredProvider,
    JSON.stringify(input.fallbackProviders ?? []),
    JSON.stringify(input.allowedModels ?? []),
    input.maxTokensPerRequest ?? null,
    input.credentialInjection !== false ? 1 : 0,
    input.rateLimitPerMinute ?? null,
    now
  );

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'user',
    actorId: 'system_default_user',
    action: 'inference_route.created',
    entityType: 'inference_routing_rule',
    entityId: id,
    details: {
      preferredProvider: input.preferredProvider,
      agentGalleryId: input.agentGalleryId,
      allowedModels: input.allowedModels,
    },
  });
  getCounter('titanx.inference', 'titanx.inference.routes_created', 'Inference routes created').add(1);

  return {
    id,
    agentGalleryId: input.agentGalleryId,
    preferredProvider: input.preferredProvider,
    fallbackProviders: input.fallbackProviders ?? [],
    allowedModels: input.allowedModels ?? [],
    maxTokensPerRequest: input.maxTokensPerRequest,
    credentialInjection: input.credentialInjection !== false,
    rateLimitPerMinute: input.rateLimitPerMinute,
    createdAt: now,
  };
}

export function listRoutes(db: ISqliteDriver, agentGalleryId?: string): InferenceRoute[] {
  const rows = agentGalleryId
    ? (db
        .prepare(
          'SELECT * FROM inference_routing_rules WHERE agent_gallery_id = ? OR agent_gallery_id IS NULL ORDER BY created_at DESC'
        )
        .all(agentGalleryId) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM inference_routing_rules ORDER BY created_at DESC').all() as Array<
        Record<string, unknown>
      >);
  return rows.map(rowToRoute);
}

export function deleteRoute(db: ISqliteDriver, routeId: string): boolean {
  const deleted = db.prepare('DELETE FROM inference_routing_rules WHERE id = ?').run(routeId).changes > 0;
  if (deleted) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'user',
      actorId: 'system_default_user',
      action: 'inference_route.deleted',
      entityType: 'inference_routing_rule',
      entityId: routeId,
    });
  }
  return deleted;
}

// ── Routing evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate which provider and model an agent should use for inference.
 * Checks agent-specific routes first, then global defaults.
 */
export function routeInferenceCall(
  db: ISqliteDriver,
  agentGalleryId: string | undefined,
  requestedModel: string
): InferenceDecision {
  // Find agent-specific route first, then global
  let route: InferenceRoute | undefined;

  if (agentGalleryId) {
    const agentRow = db
      .prepare('SELECT * FROM inference_routing_rules WHERE agent_gallery_id = ?')
      .get(agentGalleryId) as Record<string, unknown> | undefined;
    if (agentRow) route = rowToRoute(agentRow);
  }

  if (!route) {
    const globalRow = db.prepare('SELECT * FROM inference_routing_rules WHERE agent_gallery_id IS NULL').get() as
      | Record<string, unknown>
      | undefined;
    if (globalRow) route = rowToRoute(globalRow);
  }

  // No routes configured — allow anything
  if (!route) {
    return {
      provider: 'any',
      model: requestedModel,
      allowed: true,
      reason: 'No inference routing rules configured',
    };
  }

  // Check if requested model is allowed
  if (route.allowedModels.length > 0) {
    const modelAllowed = route.allowedModels.some(
      (pattern) => requestedModel === pattern || requestedModel.startsWith(pattern.replace('*', ''))
    );
    if (!modelAllowed) {
      logActivity(db, {
        userId: 'system_default_user',
        actorType: 'system',
        actorId: 'inference_gateway',
        action: 'inference.model_denied',
        entityType: 'inference_route',
        entityId: route.id,
        details: { requestedModel, allowedModels: route.allowedModels, agentGalleryId },
      });
      return {
        provider: route.preferredProvider,
        model: requestedModel,
        allowed: false,
        reason: `Model "${requestedModel}" not in allowed list: ${route.allowedModels.join(', ')}`,
        routeId: route.id,
      };
    }
  }

  return {
    provider: route.preferredProvider,
    model: requestedModel,
    allowed: true,
    reason: `Routed to ${route.preferredProvider}`,
    routeId: route.id,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToRoute(row: Record<string, unknown>): InferenceRoute {
  return {
    id: row.id as string,
    agentGalleryId: (row.agent_gallery_id as string) ?? undefined,
    preferredProvider: row.preferred_provider as string,
    fallbackProviders: JSON.parse((row.fallback_providers as string) || '[]'),
    allowedModels: JSON.parse((row.allowed_models as string) || '[]'),
    maxTokensPerRequest: (row.max_tokens_per_request as number) ?? undefined,
    credentialInjection: (row.credential_injection as number) === 1,
    rateLimitPerMinute: (row.rate_limit_per_minute as number) ?? undefined,
    createdAt: row.created_at as number,
  };
}
