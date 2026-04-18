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

/** The push envelope — wire format slave→master. */
export type LearningExportEnvelope = {
  windowStart: number;
  windowEnd: number;
  trajectories: ExportedTrajectory[];
  memorySummaries: ExportedMemorySummary[];
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
};

/** Published consolidated-learnings payload — travels in the config bundle. */
export type ConsolidatedLearningsPayload = {
  version: number;
  publishedAt: number;
  entries: ConsolidatedLearning[];
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

/** Default cadence for the slave push loop. 24h aligns with the nightly
 *  master dream pass so the master always sees fresh data each run. */
export const LEARNING_PUSH_INTERVAL_MS = 24 * 60 * 60 * 1000;
