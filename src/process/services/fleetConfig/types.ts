/**
 * @license Apache-2.0
 * Shared types for fleet config sync (Phase C).
 */

import type { IAMPolicy } from '../iamPolicies';
import type { SecurityFeature } from '../securityFeatures';
import type { GalleryAgent } from '../agentGallery';
import type { ConsolidatedLearningsPayload } from '../fleetLearning/types';

/** Managed security feature toggle row. */
export type ManagedFeatureToggle = {
  feature: SecurityFeature;
  enabled: boolean;
  updatedAt: number;
};

/**
 * Agent template shipped by master. Lean version of GalleryAgent — we
 * drop user-scoped + runtime fields (heartbeatEnabled, whitelisted,
 * etc.) that should be controlled by the slave user or reset on apply.
 * Everything the master curates is preserved.
 */
export type ManagedAgentTemplate = Pick<
  GalleryAgent,
  | 'id'
  | 'name'
  | 'agentType'
  | 'category'
  | 'description'
  | 'avatarSpriteIdx'
  | 'capabilities'
  | 'config'
  | 'maxBudgetCents'
  | 'allowedTools'
  | 'instructionsMd'
  | 'skillsMd'
  | 'heartbeatMd'
  | 'heartbeatIntervalSec'
  | 'envBindings'
  | 'createdAt'
>;

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
   * Agent templates the master has published to the fleet (Phase E).
   * Slaves insert these as `source='master'` rows in agent_gallery +
   * register `agent.template.<id>` in managed_config_keys so the UI
   * can show "Installed by IT" badges and reject local deletes.
   */
  agentTemplates: ManagedAgentTemplate[];
  /**
   * Phase C v1.11.0 — Dream Mode consolidated learnings. Master's
   * most recent dream-pass output; slaves upsert these into their
   * local reasoning_bank with source_tag='fleet_consolidated' so
   * locally-minted trajectories stay separable.
   *
   * Undefined = master has never run a dream pass, OR master is
   * pre-Phase-C (backward-compat via optional field).
   */
  consolidatedLearnings?: ConsolidatedLearningsPayload;
  /**
   * v2.6.0 Phase 3 — agent workflow templates the master has
   * published to the fleet. Slaves insert these as `source='master'`
   * rows in `workflow_definitions` and register
   * `workflow.template.<id>` in `managed_config_keys` so the UI
   * can show "Installed by IT" badges. Undefined on pre-v2.6
   * masters; slaves treat as empty list.
   */
  managedWorkflows?: ManagedWorkflowTemplate[];
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
  /** How many master-pushed agent templates landed (Phase E). */
  agentTemplatesReplaced: number;
  /** Phase C: how many fleet-consolidated learnings were upserted
   *  into reasoning_bank. 0 when bundle carries none or version
   *  matches the locally-applied consolidated version. */
  consolidatedLearningsApplied: number;
  /** v2.6.0 Phase 3: how many master-pushed workflow templates landed. */
  managedWorkflowsReplaced: number;
  /** Keys that flipped from local → managed in this apply. */
  newlyManagedKeys: string[];
};

/**
 * v2.6.0 — workflow template shipped by master. Lean version of
 * WorkflowDefinition: we include only the fields needed to rebuild
 * a usable definition on the slave (nodes + connections + metadata)
 * and drop local fields like `enabled` (slaves control enablement).
 */
export type ManagedWorkflowTemplate = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  canonicalId?: string;
  version: number;
  managedByVersion?: number;
  nodes: unknown[];
  connections: unknown[];
  settings?: Record<string, unknown>;
  createdAt: number;
};

/** Why a config version was bumped. Goes into the audit log. */
export type BumpReason =
  | 'iam.policy.created'
  | 'iam.policy.deleted'
  | 'iam.policy.bound'
  | 'iam.policy.unbound'
  | 'security_feature.toggle'
  | 'agent.template.published'
  | 'agent.template.unpublished'
  | 'agent.template.updated'
  // v2.6.0 — Agent Workflow Builder fleet publishing
  | 'workflow.published'
  | 'workflow.unpublished'
  | 'config.manual_bump'
  | 'fleet.bundle.applied';
