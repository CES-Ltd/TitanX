/**
 * @license Apache-2.0
 * Security feature toggles — master on/off switches for NemoClaw-inspired features.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';

export type SecurityFeature =
  | 'network_policies'
  | 'ssrf_protection'
  | 'filesystem_tiers'
  | 'blueprints'
  | 'agent_snapshots'
  | 'inference_routing';

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
  db.prepare('UPDATE security_feature_toggles SET enabled = ?, updated_at = ? WHERE feature = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    feature
  );
}

/** Check if a feature is enabled (convenience for runtime checks) */
export function isFeatureEnabled(db: ISqliteDriver, feature: SecurityFeature): boolean {
  return getToggle(db, feature);
}
