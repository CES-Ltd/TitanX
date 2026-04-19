/**
 * @license Apache-2.0
 * Phase C (v1.11.0) Dream Mode — shared types for the slave→master
 * learning-export channel and the master's consolidated-learnings
 * broadcast path.
 *
 * These live in their own module so the service code, the slave push
 * worker, the master ingest endpoint, and the config-bundle builder
 * can all import without cycles.
 */

/** Slave-local push worker metadata. */
export type LearningPushStatus = {
  running: boolean;
  lastPushAt?: number;
  lastWindowEnd?: number;
  lastPushError?: string;
  /** The last value of `fleet.learning.enabled` the slave observed. */
  enabled: boolean;
};

/** A single exported trajectory — slave side. */
export type ExportedTrajectory = {
  /** Stable hash so master can dedup across devices without caring
   *  about the slave-local row id. */
  trajectoryHash: string;
  taskDescription: string;
  /** JSON-stringified steps[] payload. Already deep-scrubbed for secrets. */
  trajectoryJson: string;
  successScore: number;
  /** Local usage_count on THIS slave. Master sums across devices. */
  usageCountLocal: number;
  /**
   * v2.5.0 Phase B2 — set when this trajectory came from a failed
   * turn (status not completed/active). Master's distillation
   * pass treats failure clusters as sources of avoidance rules
   * rather than preferred paths. Optional for back-compat with
   * pre-v2.5 slaves.
   */
  failurePattern?: boolean;
};

/** A single exported agent-memory summary — slave side. */
export type ExportedMemorySummary = {
  /** Anonymized agent-slot id — master doesn't need the real slot.
   *  We SHA256(slotId)[:16] so master can still dedup across devices. */
  agentSlotHash: string;
  /** JSON-stringified summary content. Already deep-scrubbed. */
  contentJson: string;
  tokenCount: number;
};

/**
 * v2.5.0 Phase B1 — consumption feedback item.
 *
 * When a slave's agent turn consumes a consolidated trajectory (via
 * findSimilarTrajectories) and the turn closes with success, the
 * slave tracks per-trajectory counters. These piggyback to master
 * on the next learning push so the dream pass can re-rank by
 * real-world adoption (not just ingestion-time signal).
 */
export type ConsumptionFeedbackItem = {
  /** trajectory_hash — master joins this back to consolidated_learnings. */
  trajectoryHash: string;
  /** How many times this slave used the entry since last push. */
  usedCount: number;
  /** Of those uses, how many ended in successScore >= 0.7. */
  successCount: number;
  /** Whether this entry came from master's consolidation
   *  (source_tag='fleet_consolidated') or is locally-minted. Master
   *  only folds consolidated ones into usage_count_fleetwide; local
   *  feedback is stored for audit but doesn't change ranking. */
  fromFleet: boolean;
};

/** The push envelope — wire format slave→master. */
export type LearningExportEnvelope = {
  windowStart: number;
  windowEnd: number;
  trajectories: ExportedTrajectory[];
  memorySummaries: ExportedMemorySummary[];
  /**
   * v2.5.0 Phase B1 — consumption feedback for consolidated entries.
   * Optional for back-compat with pre-v2.5 master (which ignores it).
   */
  consumptionFeedback?: ConsumptionFeedbackItem[];
};

/** Master's reply to a slave learning push. */
export type LearningIngestResult = {
  ok: boolean;
  /** Next window-start the slave should advance its cursor to. Usually
   *  equal to the envelope's windowEnd unless the master rejects with
   *  a specific skip window. */
  nextWindowStart: number;
  /** Per-type counts of rows the master actually ingested (master
   *  dedup across devices happens at dream time, not at ingest). */
  ingested: { trajectories: number; memorySummaries: number };
  /** Set when the master rejects the push (e.g. learning globally
   *  disabled). Slave logs the reason + stops pushing until its next
   *  opt-in cycle. */
  rejectedReason?: 'learning_globally_disabled' | 'device_opted_out' | 'rate_limited';
};

/**
 * v2.5.0 Phase C1 — structured insight extracted by the distillation
 * LLM. Pre-v2.5 entries don't have this field and keep falling back
 * to `taskDescription` for retrieval hints.
 */
export type DistilledInsightPayload = {
  taskShape: string;
  preferredPath?: string;
  avoidancePath?: string;
  triggerCondition?: string;
};

/** A single consolidated learning — produced by the dream scheduler. */
export type ConsolidatedLearning = {
  /** Preserved from the source trajectory. Slave-side idempotent
   *  upsert keys on this + version. */
  trajectoryHash: string;
  /** Distilled one-liner used by the reasoning-bank retrieval path. */
  taskDescription: string;
  /** JSON-stringified steps[] payload — the winning trajectory. */
  trajectoryJson: string;
  /** Max success_score across contributing devices. */
  successScore: number;
  /** Sum of local usage_counts across contributing devices — this is
   *  the signal reasoning-bank uses to rank consolidated entries above
   *  locally-minted ones. */
  usageCountFleetwide: number;
  /** How many distinct devices contributed to this cluster. Stored as
   *  provenance so the dashboard can render "3 devices learned this". */
  contributingDevices: number;
  /**
   * v2.5.0 Phase B2 — set when this cluster was majority-failures.
   * Slave applies `avoidancePath` as a warn-against hint rather than
   * a preferred path when injecting into the prompt.
   */
  failurePattern?: boolean;
  /**
   * v2.5.0 Phase C1 — structured distillation output. Optional; pre-
   * v2.5 consolidated rows lack this and still work via
   * `taskDescription` alone.
   */
  insight?: DistilledInsightPayload;
};

/**
 * v2.5.0 Phase C2 — consolidated memory summary, broadcast to slaves.
 *
 * Each entry represents what the fleet knows about an agent slot
 * (identified by agentSlotHash = SHA256(slotId)[:16]). Entries are
 * the N most-recent slave-side summaries for that slot, across all
 * devices. Slaves upsert these into their own agent_memory with a
 * source_tag so local agents consult fleet-wide domain knowledge
 * alongside their own history.
 */
export type ConsolidatedMemorySummary = {
  agentSlotHash: string;
  entries: Array<{
    contentJson: string;
    deviceId: string;
    receivedAt: number;
  }>;
  contributingDevices: number;
};

/**
 * v2.5.0 Phase C3 — template persona patch. The dream pass produces
 * these for agent templates that have high-signal fleet-wide clusters
 * tied to them. Slaves append the patch to the template's
 * `instructionsMd` at agent-spawn time. Kept separate from the
 * original instructions so an admin can inspect / roll back patches
 * without touching the base template.
 */
export type FleetTemplatePatch = {
  /** `agent_gallery.id` this patch applies to. Must match a synced template. */
  agentGalleryId: string;
  /** Short markdown addendum (≤1KB) describing the fleet-learned rules. */
  fleetInstructionsMd: string;
  /** Count of clusters that contributed to this patch — for audit. */
  clusterCount: number;
  /** Highest rank score among contributing clusters. */
  maxRankScore: number;
};

/** Published consolidated-learnings payload — travels in the config bundle. */
export type ConsolidatedLearningsPayload = {
  version: number;
  publishedAt: number;
  entries: ConsolidatedLearning[];
  /**
   * v2.5.0 Phase C2 — optional, consolidated memory summaries from
   * the dream pass. Pre-v2.5 master omits it; pre-v2.5 slave ignores
   * it. Both continue to work with just `entries` for trajectories.
   */
  memorySummaries?: ConsolidatedMemorySummary[];
  /**
   * v2.5.0 Phase C3 — optional template persona patches. Absent
   * when no template reached the patch-worthy threshold in the
   * last pass. Pre-v2.5 slaves ignore this field.
   */
  templatePatches?: FleetTemplatePatch[];
};

/** Caps enforced by the slave push worker. */
export const LEARNING_EXPORT_LIMITS = {
  /** Max trajectories per window. Keeps request size bounded. */
  MAX_TRAJECTORIES_PER_WINDOW: 100,
  /** Max memory summaries per window. Summaries are typically larger
   *  than trajectory steps, so a tighter cap. */
  MAX_MEMORY_SUMMARIES_PER_WINDOW: 50,
  /** Soft cap on total body size — drops lowest-score trajectories
   *  until under budget. */
  MAX_PAYLOAD_BYTES: 500_000,
} as const;

/**
 * Default cadence for the slave push loop.
 *
 * v2.5.0 Phase A2 — lowered from 24h → 2h. The 24h setting aligned with
 * the nightly 03:00 dream pass, but it meant a lesson learned at
 * 10:00 AM on Slave A couldn't help Slave B until 40+ hours later
 * (24h push + 24h dream cycle + 30s config-pull). Two hours is still
 * lightweight at scale (payloads are capped at 500KB, the dream
 * scheduler now threshold-triggers before the nightly timer, and
 * push only fires if there are unexported trajectories in the
 * window), so the extra frequency is effectively free when fleets
 * are idle.
 *
 * Operators can still tune via TITANX_LEARNING_PUSH_HOURS (min 1,
 * max 168); 2h is the sensible default for self-evolving fleets.
 */
export const LEARNING_PUSH_INTERVAL_MS = 2 * 60 * 60 * 1000;
