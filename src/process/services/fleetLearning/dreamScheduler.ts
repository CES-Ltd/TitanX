/**
 * @license Apache-2.0
 * Phase C (v1.11.0) Dream Mode — master-only consolidation scheduler.
 *
 * Nightly, master ingests every `fleet_learnings` row that isn't yet
 * tagged with a consolidated_version and runs a three-pass pipeline:
 *
 *   Pass 1 — DEDUP
 *     Group trajectories across devices by trajectory_hash. Each
 *     cluster becomes one candidate ConsolidatedLearning. The winning
 *     trajectory within a cluster is the one with max(success_score);
 *     ties broken by max(usage_count_local). usage_count_fleetwide is
 *     the SUM of local counts across the cluster.
 *
 *   Pass 2 — GENERALIZE (LLM distillation, best-effort)
 *     For clusters meeting the "high frequency" bar (≥3 contributing
 *     devices, ≥5 total usage), ask the master's default LLM to
 *     distill a concise one-line task description. Failure or disabled
 *     LLM = fall through to the winning trajectory's raw description
 *     (pass is best-effort).
 *
 *   Pass 3 — RANK
 *     Score each consolidated entry by usage_count_fleetwide *
 *     avgSuccessScore. Keep top N (default 500). Emit a single JSON
 *     blob as payload, bump version, record contributing_devices +
 *     trajectory_count for observability.
 *
 * Output table: consolidated_learnings(version, published_at, payload).
 * Side effect: marks every source fleet_learnings row with the new
 * version so the next run only touches newly-arrived rows.
 *
 * Timing:
 *   - Default run-time: 03:00 local (TITANX_DREAM_HOUR env override).
 *   - Pattern: `setTimeout` to next 03:00, then `setInterval(24h)` for
 *     the recurring slot. Same shape as pruning.ts, just time-of-day
 *     aligned.
 *   - Admin can trigger a run on-demand via `runDreamPass()` — feeds
 *     the "Run Dream Now" UI button.
 */

import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import { getDatabase } from '../database';
import type { ConsolidatedLearning } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DREAM_HOUR_LOCAL = 3;
const DEFAULT_KEEP_TOP_N = 500;
const HIGH_FREQUENCY_MIN_DEVICES = 3;
const HIGH_FREQUENCY_MIN_USAGE = 5;

/**
 * v2.5.0 Phase A2 — threshold-triggered consolidation. If this many
 * unconsolidated trajectories pile up, the scheduler fires immediately
 * instead of waiting for the nightly timer. Keeps latency bounded for
 * active fleets without burning LLM tokens on quiet ones.
 */
const CONSOLIDATION_THRESHOLD = 50;
/** Cadence of the threshold poll. Cheap COUNT(*) query, safe to run often. */
const THRESHOLD_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min
/**
 * v2.5.0 Phase A2 — catch-up window on boot. If the last consolidation
 * finished more than CATCHUP_GRACE_MS ago, the scheduler fires a pass
 * at boot instead of waiting for the next 03:00. Covers the "app was
 * down at 03:00" case.
 */
const CATCHUP_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

let _dreamTimer: ReturnType<typeof setInterval> | null = null;
let _firstRunTimeout: ReturnType<typeof setTimeout> | null = null;
let _thresholdPollTimer: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

export type DreamPassResult = {
  version: number;
  publishedAt: number;
  trajectoryCount: number;
  contributingDevices: number;
  elapsedMs: number;
};

/**
 * Compute ms from now until the next occurrence of `hour:00` local time.
 * Used to align the first run of the 24h interval — so the scheduler
 * always runs at the same time of day regardless of when the app booted.
 *
 * Edge case: if today's hour has already passed, advance to tomorrow.
 */
export function msUntilNextHour(now: Date, hourLocal: number): number {
  const target = new Date(now);
  target.setHours(hourLocal, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Start the nightly dream scheduler. Safe to call repeatedly — idempotent.
 *
 * Hour selection: TITANX_DREAM_HOUR env var (0-23), falls back to 3 AM
 * local. Out-of-range values fall back to default without throwing.
 */
export function startDreamScheduler(db: ISqliteDriver): void {
  if (_dreamTimer || _firstRunTimeout) return;
  const hour = resolveDreamHour();
  const delayMs = msUntilNextHour(new Date(), hour);

  // v2.5.0 Phase A2 — catch-up on boot. If the master was offline past
  // a scheduled pass, the nightly fixed-hour schedule would silently
  // skip that day. Check last consolidation recency: if stale, fire
  // now (after a short jitter so we don't hammer the LLM on every boot
  // of a cluster of masters).
  const stale = isConsolidationStale(db);
  if (stale) {
    const jitterMs = 30_000 + Math.floor(Math.random() * 60_000); // 30-90s
    console.log(
      `[Dream] Last consolidation is stale (>24h) — firing catch-up pass in ${String(Math.round(jitterMs / 1000))}s`
    );
    setTimeout(() => void runDreamPass(db), jitterMs);
  }

  console.log(
    `[Dream] Scheduler started — first run in ${String(Math.round(delayMs / 1000 / 60))} min (${String(hour)}:00 local), then every 24h`
  );
  _firstRunTimeout = setTimeout(() => {
    void runDreamPass(db);
    _dreamTimer = setInterval(() => void runDreamPass(db), DAY_MS);
  }, delayMs);

  // v2.5.0 Phase A2 — threshold poll. Every 10 min, check how many
  // unconsolidated rows sit in fleet_learnings; if over the threshold,
  // fire a pass. Lets active fleets consolidate near-real-time without
  // burning LLM tokens on quiet ones.
  _thresholdPollTimer = setInterval(() => {
    try {
      const count = countUnconsolidated(db);
      if (count >= CONSOLIDATION_THRESHOLD && !_inFlight) {
        console.log(`[Dream] Threshold reached (${String(count)} unconsolidated) — firing pass now`);
        void runDreamPass(db);
      }
    } catch (e) {
      console.warn('[Dream] threshold poll failed:', e);
    }
  }, THRESHOLD_POLL_INTERVAL_MS);
}

function isConsolidationStale(db: ISqliteDriver): boolean {
  try {
    const row = db.prepare('SELECT MAX(published_at) AS ts FROM consolidated_learnings').get() as
      | { ts: number | null }
      | undefined;
    const last = row?.ts ?? 0;
    // Never consolidated → yes, stale (but only fire if there are
    // rows to consolidate).
    if (last === 0) return countUnconsolidated(db) > 0;
    return Date.now() - last > CATCHUP_GRACE_MS;
  } catch {
    return false;
  }
}

function countUnconsolidated(db: ISqliteDriver): number {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM fleet_learnings WHERE consolidated_version IS NULL AND learning_type = 'trajectory'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function stopDreamScheduler(): void {
  if (_firstRunTimeout) {
    clearTimeout(_firstRunTimeout);
    _firstRunTimeout = null;
  }
  if (_dreamTimer) {
    clearInterval(_dreamTimer);
    _dreamTimer = null;
  }
  if (_thresholdPollTimer) {
    clearInterval(_thresholdPollTimer);
    _thresholdPollTimer = null;
  }
}

export function __resetDreamSchedulerForTests(): void {
  stopDreamScheduler();
  _inFlight = false;
}

function resolveDreamHour(): number {
  const raw = process.env.TITANX_DREAM_HOUR;
  if (!raw) return DEFAULT_DREAM_HOUR_LOCAL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 23) return DEFAULT_DREAM_HOUR_LOCAL;
  return n;
}

/**
 * Execute one consolidation pass. Returns metadata; throws on
 * unrecoverable errors (caller in the scheduler swallows the throw
 * via the setInterval closure, but tests want structured results).
 *
 * Coalesces concurrent callers via `_inFlight`. A concurrent "Run
 * Dream Now" + scheduled run = the second one returns early with the
 * first one's pending work.
 */
export async function runDreamPass(db: ISqliteDriver, options?: { keepTopN?: number }): Promise<DreamPassResult> {
  if (_inFlight) {
    console.log('[Dream] Skipping — previous pass still in flight');
    return { version: 0, publishedAt: 0, trajectoryCount: 0, contributingDevices: 0, elapsedMs: 0 };
  }
  _inFlight = true;
  const keepTopN = options?.keepTopN ?? DEFAULT_KEEP_TOP_N;
  const started = Date.now();

  try {
    // v2.5.0 Phase B1 — build a consumption-feedback index first so
    // Pass 1's cluster scoring can boost clusters that slaves have
    // actually used successfully. Each fleet_learnings row with
    // learning_type='consumption_feedback' has a JSON payload with
    // { trajectoryHash, usedCount, successCount }.
    const feedbackRows = db
      .prepare(
        `SELECT device_id, payload, usage_count_local
         FROM fleet_learnings
         WHERE learning_type = 'consumption_feedback' AND consolidated_version IS NULL`
      )
      .all() as Array<{ device_id: string; payload: string; usage_count_local: number | null }>;
    const feedbackByHash = new Map<
      string,
      { usedCount: number; successCount: number; deviceSet: Set<string>; sourceIds: string[] }
    >();
    const feedbackSourceIds: string[] = [];
    for (const row of feedbackRows) {
      try {
        const p = JSON.parse(row.payload) as { trajectoryHash?: string; usedCount?: number; successCount?: number };
        if (!p.trajectoryHash || typeof p.trajectoryHash !== 'string') continue;
        const entry = feedbackByHash.get(p.trajectoryHash) ?? {
          usedCount: 0,
          successCount: 0,
          deviceSet: new Set<string>(),
          sourceIds: [],
        };
        entry.usedCount += p.usedCount ?? 0;
        entry.successCount += p.successCount ?? 0;
        entry.deviceSet.add(row.device_id);
        feedbackByHash.set(p.trajectoryHash, entry);
      } catch {
        /* skip malformed */
      }
    }
    feedbackSourceIds.push(
      ...(
        db
          .prepare(
            `SELECT id FROM fleet_learnings WHERE learning_type = 'consumption_feedback' AND consolidated_version IS NULL`
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    );

    // Pass 1: dedup + bucket-by-hash across devices.
    const trajectoryRows = db
      .prepare(
        `SELECT id, device_id, payload, success_score, usage_count_local
         FROM fleet_learnings
         WHERE learning_type = 'trajectory' AND consolidated_version IS NULL`
      )
      .all() as Array<{
      id: string;
      device_id: string;
      payload: string;
      success_score: number | null;
      usage_count_local: number | null;
    }>;

    type Cluster = {
      trajectoryHash: string;
      taskDescription: string;
      trajectoryJson: string;
      maxScore: number;
      totalUsage: number;
      deviceSet: Set<string>;
      sourceIds: string[];
      /** v2.5.0 Phase B2 — true if >=50% of contributing rows were failures. */
      failurePattern?: boolean;
      /** v2.5.0 Phase C1 — populated by tryDistillBatch when the LLM responds. */
      insight?: DistilledInsight | null;
      /** Raw counts for the failure/success majority decision. */
      _failureCount?: number;
    };
    const byHash = new Map<string, Cluster>();

    for (const row of trajectoryRows) {
      let payload: {
        trajectoryHash?: string;
        taskDescription?: string;
        trajectoryJson?: string;
        failurePattern?: boolean;
      };
      try {
        payload = JSON.parse(row.payload) as typeof payload;
      } catch {
        continue;
      }
      if (!payload.trajectoryHash || typeof payload.trajectoryHash !== 'string') continue;
      const hash = payload.trajectoryHash;
      const score = row.success_score ?? 0;
      const usage = row.usage_count_local ?? 0;
      const isFailure = payload.failurePattern === true;

      const existing = byHash.get(hash);
      if (!existing) {
        byHash.set(hash, {
          trajectoryHash: hash,
          taskDescription: payload.taskDescription ?? '',
          trajectoryJson: payload.trajectoryJson ?? '[]',
          maxScore: score,
          totalUsage: usage,
          deviceSet: new Set([row.device_id]),
          sourceIds: [row.id],
          _failureCount: isFailure ? 1 : 0,
        });
        continue;
      }
      existing.totalUsage += usage;
      existing.deviceSet.add(row.device_id);
      existing.sourceIds.push(row.id);
      if (isFailure) existing._failureCount = (existing._failureCount ?? 0) + 1;
      // Winning trajectory replaces on strictly greater score;
      // ties keep the existing winner (stable).
      if (score > existing.maxScore) {
        existing.maxScore = score;
        existing.taskDescription = payload.taskDescription ?? existing.taskDescription;
        existing.trajectoryJson = payload.trajectoryJson ?? existing.trajectoryJson;
      }
    }

    // v2.5.0 Phase B2 — tag clusters as failure patterns if the
    // majority of contributing rows were failures. Distillation uses
    // this to pick the avoidance-rule prompt variant.
    for (const cluster of byHash.values()) {
      const failures = cluster._failureCount ?? 0;
      cluster.failurePattern = failures > cluster.sourceIds.length / 2;
    }

    // Pass 2: GENERALIZE (best-effort LLM distillation).
    // For each "high frequency" cluster, try to distill a concise
    // one-line description. On any LLM error we fall through to the
    // original description — never block the pass on model failures.
    //
    // v2.5.0 Phase C1 — distillation now produces a structured
    // DistilledInsight (taskShape + preferredPath / avoidancePath +
    // triggerCondition). Failure clusters use the avoidance-rule
    // prompt; success clusters use the preferred-path prompt.
    const highFreqClusters = Array.from(byHash.values()).filter(
      (c) => c.deviceSet.size >= HIGH_FREQUENCY_MIN_DEVICES && c.totalUsage >= HIGH_FREQUENCY_MIN_USAGE
    );
    if (highFreqClusters.length > 0) {
      await tryDistillBatch(highFreqClusters);
    }

    // Pass 3: RANK + top-N truncation.
    //
    // v2.5.0 Phase B1 — fold consumption feedback into the ranking.
    // If slaves reported usage of a previously-consolidated trajectory
    // via consumption_feedback rows, its adoption signal boosts the
    // score. Formula: `score = maxScore * (ingestion_usage +
    // adoption_usage) * adoption_success_ratio`. Trajectories that
    // are actually used in the wild outrank those that only look good
    // on paper.
    const ranked: ConsolidatedLearning[] = Array.from(byHash.values())
      .map((c) => {
        const feedback = feedbackByHash.get(c.trajectoryHash);
        const adoptionUsage = feedback?.usedCount ?? 0;
        const adoptionSuccess = feedback?.successCount ?? 0;
        const adoptionRatio = feedback && feedback.usedCount > 0 ? feedback.successCount / feedback.usedCount : 1;
        const rankScore = c.maxScore * (c.totalUsage + adoptionUsage) * adoptionRatio;
        return {
          trajectoryHash: c.trajectoryHash,
          taskDescription: c.taskDescription,
          trajectoryJson: c.trajectoryJson,
          successScore: c.maxScore,
          usageCountFleetwide: c.totalUsage + adoptionUsage,
          contributingDevices: c.deviceSet.size + (feedback?.deviceSet.size ?? 0),
          rankScore,
          adoptionUsage,
          adoptionSuccess,
        };
      })
      .toSorted((a, b) => b.rankScore - a.rankScore)
      .slice(0, keepTopN)
      .map((c) => {
        // Look up the full cluster to recover insight / failurePattern
        // (the slim ranking object above dropped them for sort speed).
        const fullCluster = byHash.get(c.trajectoryHash);
        return {
          trajectoryHash: c.trajectoryHash,
          taskDescription: c.taskDescription,
          trajectoryJson: c.trajectoryJson,
          successScore: c.successScore,
          usageCountFleetwide: c.usageCountFleetwide,
          contributingDevices: c.contributingDevices,
          // v2.5.0 Phase B2/C1 — carry structured insight + failure
          // flag into the broadcast payload.
          failurePattern: fullCluster?.failurePattern === true ? true : undefined,
          insight: fullCluster?.insight ?? undefined,
        };
      });

    // v2.5.0 Phase C2 — consolidate memory_summary rows alongside
    // trajectories. Pre-v2.5 these piled up in fleet_learnings
    // forever with consolidated_version IS NULL — half the input
    // signal was inert. Simpler model than trajectories: group by
    // agentSlotHash (same "domain owner") and keep the top N by
    // token_count as representatives of that domain. No LLM call —
    // summaries are already distilled by the slave's memory system.
    const summaryRows = db
      .prepare(
        `SELECT id, device_id, payload, received_at
         FROM fleet_learnings
         WHERE learning_type = 'memory_summary' AND consolidated_version IS NULL`
      )
      .all() as Array<{ id: string; device_id: string; payload: string; received_at: number }>;
    type SummaryBucket = {
      agentSlotHash: string;
      entries: Array<{ contentJson: string; deviceId: string; receivedAt: number }>;
      deviceSet: Set<string>;
      sourceIds: string[];
    };
    const bySlot = new Map<string, SummaryBucket>();
    for (const row of summaryRows) {
      try {
        const p = JSON.parse(row.payload) as { agentSlotHash?: string; contentJson?: string };
        if (!p.agentSlotHash || typeof p.agentSlotHash !== 'string') continue;
        const bucket = bySlot.get(p.agentSlotHash) ?? {
          agentSlotHash: p.agentSlotHash,
          entries: [],
          deviceSet: new Set<string>(),
          sourceIds: [],
        };
        bucket.entries.push({
          contentJson: p.contentJson ?? '',
          deviceId: row.device_id,
          receivedAt: row.received_at,
        });
        bucket.deviceSet.add(row.device_id);
        bucket.sourceIds.push(row.id);
        bySlot.set(p.agentSlotHash, bucket);
      } catch {
        /* skip malformed */
      }
    }
    // Keep 5 most-recent summaries per slot → those are the signal
    // for "what this agent recently learned about its domain."
    const summaryPerSlotCap = 5;
    const consolidatedSummaries: Array<{
      agentSlotHash: string;
      entries: Array<{ contentJson: string; deviceId: string; receivedAt: number }>;
      contributingDevices: number;
    }> = [];
    for (const bucket of bySlot.values()) {
      const top = bucket.entries.toSorted((a, b) => b.receivedAt - a.receivedAt).slice(0, summaryPerSlotCap);
      consolidatedSummaries.push({
        agentSlotHash: bucket.agentSlotHash,
        entries: top,
        contributingDevices: bucket.deviceSet.size,
      });
    }

    const nextVersionRow = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM consolidated_learnings').get() as {
      v: number;
    };
    const version = nextVersionRow.v + 1;
    const publishedAt = Date.now();
    const contributingDeviceCount = new Set(Array.from(byHash.values()).flatMap((c) => Array.from(c.deviceSet))).size;

    // v2.5.0 Phase C3 — template persona patches. For each agent
    // template that has N+ high-signal clusters (trajectories
    // referencing it), build a short markdown addendum that slaves
    // append to the template's instructionsMd at spawn time. We
    // don't know which template a trajectory belongs to from the
    // cluster alone (pre-v2.5 trajectory records didn't carry a
    // template id), so we key by agentSlotHash across summaries
    // which IS tied to template identity (agent_slot_id →
    // conversation → agent_gallery.id). For v2.5.0 we seed the
    // patch from the memory-summary consolidation above — templates
    // with active domain knowledge on the fleet get a patch; others
    // stay un-patched. Future passes will tighten the correlation.
    const templatePatches = buildTemplatePatches(db, consolidatedSummaries);

    db.prepare(
      `INSERT INTO consolidated_learnings (version, published_at, payload, trajectory_count, contributing_devices)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      version,
      publishedAt,
      JSON.stringify({
        trajectories: ranked,
        memorySummaries: consolidatedSummaries,
        templatePatches,
      }),
      ranked.length,
      contributingDeviceCount
    );

    // Mark source rows as consumed so the next run only sees new data.
    // v2.5.0 Phase B1 — also consume consumption_feedback rows.
    // v2.5.0 Phase C2 — also consume memory_summary rows.
    const memorySourceIds = Array.from(bySlot.values()).flatMap((b) => b.sourceIds);
    const allSourceIds = [
      ...Array.from(byHash.values()).flatMap((c) => c.sourceIds),
      ...feedbackSourceIds,
      ...memorySourceIds,
    ];
    if (allSourceIds.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < allSourceIds.length; i += chunkSize) {
        const slice = allSourceIds.slice(i, i + chunkSize);
        const placeholders = slice.map(() => '?').join(',');
        db.prepare(`UPDATE fleet_learnings SET consolidated_version = ? WHERE id IN (${placeholders})`).run(
          version,
          ...slice
        );
      }
    }

    try {
      logActivity(db, {
        userId: 'system_default_user',
        actorType: 'system',
        actorId: 'fleet_dream_scheduler',
        action: 'fleet.learning.dream_pass',
        entityType: 'fleet_learning',
        entityId: String(version),
        details: {
          trajectoryCount: ranked.length,
          contributingDevices: contributingDeviceCount,
          clustersInput: byHash.size,
          sourceRowsConsumed: allSourceIds.length,
        },
      });
    } catch (e) {
      logNonCritical('fleet.learning.audit-dream', e);
    }

    const elapsedMs = Date.now() - started;
    console.log(
      `[Dream] Pass v${String(version)} done: ${String(ranked.length)} entries, ${String(contributingDeviceCount)} devices, ${String(elapsedMs)}ms`
    );

    return {
      version,
      publishedAt,
      trajectoryCount: ranked.length,
      contributingDevices: contributingDeviceCount,
      elapsedMs,
    };
  } finally {
    _inFlight = false;
  }
}

/**
 * v2.5.0 Phase C1 — structured distillation.
 *
 * Pre-v2.5 this function asked the LLM to compress the task
 * description into ≤15 words. That produced a renamed task, not a
 * generalizable rule — agents got the same guidance they'd get from
 * the raw description with extra LLM cost and latency.
 *
 * v2.5.0 upgrades the prompt to extract structured knowledge:
 *   - `taskShape` — normalized intent (the old 15-word compression)
 *   - `preferredPath` — winning tool sequence for success clusters
 *   - `avoidancePath` — known-bad tool sequence for failure clusters
 *   - `triggerCondition` — "when user says X, expect Y to fail if Z"
 *
 * Output is JSON parsed into DistilledInsight. Cluster mutation writes
 * both `taskDescription` (for back-compat with pre-v2.5 retrieval)
 * AND a new `insight` field (for Phase C3 template evolution + slave
 * retrieval hints). Best-effort: on any parse failure or LLM error,
 * the cluster keeps its original description and a null insight.
 */
type DistilledInsight = {
  taskShape: string;
  preferredPath?: string;
  avoidancePath?: string;
  triggerCondition?: string;
};

type DistillableCluster = {
  taskDescription: string;
  trajectoryJson: string;
  failurePattern?: boolean;
  insight?: DistilledInsight | null;
};

async function tryDistillBatch(clusters: DistillableCluster[]): Promise<void> {
  try {
    const { ProcessConfig } = await import('@process/utils/initStorage');
    const providers = (await ProcessConfig.get('model.config')) as
      | Array<import('@/common/config/storage').IProvider>
      | undefined;
    if (!Array.isArray(providers) || providers.length === 0) return;
    const enabled = providers.find((p) => p.enabled !== false);
    if (!enabled) return;
    const provider: import('@/common/config/storage').TProviderWithModel = {
      ...enabled,
      useModel: Array.isArray(enabled.model) && enabled.model.length > 0 ? enabled.model[0] : 'auto',
    } as import('@/common/config/storage').TProviderWithModel;
    const { createChatModel } = await import('@process/services/deepAgent/langgraph/providers');
    const llm = await createChatModel(provider);

    // Distill in sequence, not parallel. Rate-limit-friendly; a batch
    // of 100 clusters at 500ms each is 50s total which beats the 24h
    // cadence by three orders of magnitude — no need for concurrency.
    for (const cluster of clusters) {
      try {
        const systemPrompt = cluster.failurePattern
          ? `You are analyzing a cluster of failed agent turns across a fleet. Extract generalizable AVOIDANCE knowledge.

Return strict JSON with these fields (no prose, no markdown fences):
{
  "taskShape": "<1 sentence, max 15 words, normalized intent>",
  "avoidancePath": "<the tool sequence that tends to fail, 1 short sentence>",
  "triggerCondition": "<when to watch for this failure, 1 short sentence; optional>"
}

No other fields. If unsure, omit the optional field entirely rather than guessing.`
          : `You are analyzing a cluster of successful agent turns across a fleet. Extract generalizable REUSABLE knowledge.

Return strict JSON with these fields (no prose, no markdown fences):
{
  "taskShape": "<1 sentence, max 15 words, normalized intent>",
  "preferredPath": "<the tool sequence that works, 1 short sentence>",
  "triggerCondition": "<when to apply this pattern, 1 short sentence; optional>"
}

No other fields. If unsure, omit the optional field entirely rather than guessing.`;

        const userContent = `Task description: ${cluster.taskDescription}\nTool steps (JSON): ${cluster.trajectoryJson.slice(0, 2000)}`;

        const response = await llm.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ]);
        const text =
          typeof response.content === 'string'
            ? response.content
            : Array.isArray(response.content)
              ? response.content
                  .map((p) =>
                    typeof p === 'object' && p && 'text' in p && typeof (p as { text: unknown }).text === 'string'
                      ? (p as { text: string }).text
                      : ''
                  )
                  .join(' ')
              : '';
        const parsed = parseDistilledInsight(text);
        if (parsed) {
          cluster.insight = parsed;
          if (parsed.taskShape.length > 0 && parsed.taskShape.length <= 300) {
            cluster.taskDescription = parsed.taskShape;
          }
        }
      } catch (e) {
        // Swallow per-cluster; keep original description.
        logNonCritical('fleet.learning.distill-cluster', e);
      }
    }
  } catch (e) {
    // Whole-batch failure (bad provider config, network) — leave all
    // descriptions untouched.
    logNonCritical('fleet.learning.distill-batch', e);
  }
}

/**
 * v2.5.0 Phase C3 — synthesize template patches from the
 * consolidated memory summaries. For each agentSlotHash bucket with
 * >=2 contributing devices, build a short markdown patch that slaves
 * will append to the corresponding template's `instructionsMd` at
 * spawn time. agentSlotHash ↔ template id mapping is done slave-side
 * (each slave knows which template its agent_slot_id came from via
 * agent_gallery.id = agentSlotHash lookup).
 *
 * Intentionally conservative — we don't call the LLM here, just
 * produce a deterministic patch from the summary content. A later
 * iteration can add an LLM refinement step if the quality bar
 * warrants it.
 */
function buildTemplatePatches(
  _db: ISqliteDriver,
  summaries: Array<{
    agentSlotHash: string;
    entries: Array<{ contentJson: string; deviceId: string; receivedAt: number }>;
    contributingDevices: number;
  }>
): Array<{ agentGalleryId: string; fleetInstructionsMd: string; clusterCount: number; maxRankScore: number }> {
  const MIN_DEVICES_FOR_PATCH = 2;
  const MAX_PATCH_BYTES = 1024;
  return summaries
    .filter((s) => s.contributingDevices >= MIN_DEVICES_FOR_PATCH)
    .map((s) => {
      // The agentGalleryId IS the agent_gallery.id on the slave; the
      // slave's agent_memory.agent_slot_id is the synthetic teammate
      // slot id on master, whose fleetBinding.remoteSlotId equals
      // the slave's agent_gallery.id. Close enough for v2.5.0 — the
      // slave validates existence before writing anyway.
      const agentGalleryId = s.agentSlotHash;
      const bulletPoints = s.entries.slice(0, 3).map((e) => {
        const excerpt = (e.contentJson || '').slice(0, 180).replace(/\s+/g, ' ');
        return `- ${excerpt}`;
      });
      const md = [
        `## Fleet-Learned Notes (${String(s.contributingDevices)} device${s.contributingDevices === 1 ? '' : 's'})`,
        '',
        'Recent recurring observations across the fleet for this agent persona:',
        '',
        ...bulletPoints,
        '',
        '_Apply these as weak hints — defer to the base instructions on conflict._',
      ].join('\n');
      const fleetInstructionsMd = md.length > MAX_PATCH_BYTES ? md.slice(0, MAX_PATCH_BYTES - 3) + '...' : md;
      return {
        agentGalleryId,
        fleetInstructionsMd,
        clusterCount: s.entries.length,
        maxRankScore: 0, // reserved for v2.6.0 — tie into ranked trajectory scores
      };
    });
}

/**
 * v2.5.0 Phase C1 — parse the structured-JSON response from the
 * distillation LLM. Handles models that wrap JSON in ```json fences
 * (common with Claude Sonnet / GPT-4) by stripping them before
 * JSON.parse. Returns null on any validation failure — caller treats
 * that as "keep the original description, no insight extracted."
 */
function parseDistilledInsight(raw: string): DistilledInsight | null {
  if (!raw) return null;
  let body = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the model wrapped
  // its response.
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch && fenceMatch[1]) body = fenceMatch[1].trim();
  // Find the first { and last } — more forgiving than a strict
  // whole-string parse when the model adds a trailing explanation.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as unknown;
    if (obj === null || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.taskShape !== 'string' || rec.taskShape.length === 0) return null;
    const insight: DistilledInsight = { taskShape: rec.taskShape };
    if (typeof rec.preferredPath === 'string' && rec.preferredPath.length > 0) {
      insight.preferredPath = rec.preferredPath;
    }
    if (typeof rec.avoidancePath === 'string' && rec.avoidancePath.length > 0) {
      insight.avoidancePath = rec.avoidancePath;
    }
    if (typeof rec.triggerCondition === 'string' && rec.triggerCondition.length > 0) {
      insight.triggerCondition = rec.triggerCondition;
    }
    return insight;
  } catch {
    return null;
  }
}

/**
 * Admin-triggered one-shot. Differs from the scheduled version only
 * in that it opens the DB handle itself — IPC caller doesn't need
 * to wire the driver through.
 */
export async function runDreamNow(options?: { keepTopN?: number }): Promise<DreamPassResult> {
  const db = await getDatabase();
  return runDreamPass(db.getDriver(), options);
}
