/**
 * @license Apache-2.0
 * Security feature toggles — master on/off switches for NemoClaw-inspired features.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan, getCounter } from '../telemetry';
import { bumpConfigVersion } from '../fleetConfig';
import { logNonCritical } from '@process/utils/logNonCritical';

export type SecurityFeature =
  | 'network_policies'
  | 'ssrf_protection'
  | 'filesystem_tiers'
  | 'blueprints'
  | 'agent_snapshots'
  | 'inference_routing'
  | 'workflow_gates'
  | 'agent_memory'
  | 'agent_planning'
  | 'trace_system'
  // v1.9.26+ fleet mode (master/slave). Default ON — admins disable this
  // to force an install into Regular mode even if fleet.mode was set.
  | 'fleet_mode_enabled';

export type FeatureToggle = {
  feature: SecurityFeature;
  enabled: boolean;
  updatedAt: number;
};

/** Get all feature toggles */
export function listToggles(db: ISqliteDriver): FeatureToggle[] {
  const rows = db.prepare('SELECT * FROM security_feature_toggles ORDER BY feature ASC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    feature: r.feature as SecurityFeature,
    enabled: (r.enabled as number) === 1,
    updatedAt: r.updated_at as number,
  }));
}

/** Get a single feature toggle */
export function getToggle(db: ISqliteDriver, feature: SecurityFeature): boolean {
  const row = db.prepare('SELECT enabled FROM security_feature_toggles WHERE feature = ?').get(feature) as
    | { enabled: number }
    | undefined;
  return row ? row.enabled === 1 : false;
}

/** Set a feature toggle */
export function setToggle(db: ISqliteDriver, feature: SecurityFeature, enabled: boolean): void {
  const span = startSpan('titanx.security', 'security_feature.toggle', { feature, enabled: enabled ? 1 : 0 });

  db.prepare('UPDATE security_feature_toggles SET enabled = ?, updated_at = ? WHERE feature = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    feature
  );

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'user',
    actorId: 'system_default_user',
    action: enabled ? 'security_feature.enabled' : 'security_feature.disabled',
    entityType: 'security_feature',
    entityId: feature,
    details: { feature, enabled },
  });

  getCounter('titanx.security', 'titanx.security.feature_toggles', 'Security feature toggle changes').add(1, {
    feature,
    action: enabled ? 'enabled' : 'disabled',
  });

  // Fleet config bump — security features are part of the master->slave
  // config bundle, so any toggle needs to invalidate slave caches.
  try {
    bumpConfigVersion(db, { reason: 'security_feature.toggle', updatedBy: 'system_default_user', entityId: feature });
  } catch (e) {
    logNonCritical('fleet.config.bump.security_feature', e);
  }

  span.setStatus('ok');
  span.end();
}

/** Check if a feature is enabled (convenience for runtime checks) */
export function isFeatureEnabled(db: ISqliteDriver, feature: SecurityFeature): boolean {
  return getToggle(db, feature);
}
