/**
 * @license Apache-2.0
 * Shared types for fleet config sync (Phase C).
 */

import type { IAMPolicy } from '../iamPolicies';
import type { SecurityFeature } from '../securityFeatures';

/** Managed security feature toggle row. */
export type ManagedFeatureToggle = {
  feature: SecurityFeature;
  enabled: boolean;
  updatedAt: number;
};

/**
 * Config bundle shape — what master returns via GET /api/fleet/config,
 * what slave applies to its local DB. Version-based delta: slave sends
 * `since` = its last-applied version; master returns the full bundle
 * (not a diff) plus the new version. Bundle is small enough (kilobytes)
 * that full-replace is simpler than patch merging.
 */
export type FleetConfigBundle = {
  /** Master's current config version. Monotonic, increments on mutation. */
  version: number;
  /** Epoch ms when master last bumped version. */
  updatedAt: number;
  /** Who bumped it (admin user id or 'system' for automated bumps). */
  updatedBy: string;
  /** All IAM policies the master wants applied fleet-wide. Empty = no policies. */
  iamPolicies: IAMPolicy[];
  /** Full list of feature toggles the master controls (subset replaced on slave). */
  securityFeatures: ManagedFeatureToggle[];
  /**
   * True when the caller's `since` was already >= master version — slave
   * can skip the apply step. Lets slaves poll efficiently.
   */
  upToDate: boolean;
};

/** Result of applying a bundle on a slave. */
export type ApplyBundleResult = {
  version: number;
  iamPoliciesReplaced: number;
  securityFeaturesUpdated: number;
  /** Keys that flipped from local → managed in this apply. */
  newlyManagedKeys: string[];
};

/** Why a config version was bumped. Goes into the audit log. */
export type BumpReason =
  | 'iam.policy.created'
  | 'iam.policy.deleted'
  | 'iam.policy.bound'
  | 'iam.policy.unbound'
  | 'security_feature.toggle'
  | 'config.manual_bump'
  | 'fleet.bundle.applied';
