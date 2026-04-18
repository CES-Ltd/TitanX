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

let _dreamTimer: ReturnType<typeof setInterval> | null = null;
let _firstRunTimeout: ReturnType<typeof setTimeout> | null = null;
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
  console.log(
    `[Dream] Scheduler started — first run in ${String(Math.round(delayMs / 1000 / 60))} min (${String(hour)}:00 local), then every 24h`
  );
  _firstRunTimeout = setTimeout(() => {
    void runDreamPass(db);
    _dreamTimer = setInterval(() => void runDreamPass(db), DAY_MS);
  }, delayMs);
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
    };
    const byHash = new Map<string, Cluster>();

    for (const row of trajectoryRows) {
      let payload: { trajectoryHash?: string; taskDescription?: string; trajectoryJson?: string };
      try {
        payload = JSON.parse(row.payload) as typeof payload;
      } catch {
        continue;
      }
      if (!payload.trajectoryHash || typeof payload.trajectoryHash !== 'string') continue;
      const hash = payload.trajectoryHash;
      const score = row.success_score ?? 0;
      const usage = row.usage_count_local ?? 0;

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
        });
        continue;
      }
      existing.totalUsage += usage;
      existing.deviceSet.add(row.device_id);
      existing.sourceIds.push(row.id);
      // Winning trajectory replaces on strictly greater score;
      // ties keep the existing winner (stable).
      if (score > existing.maxScore) {
        existing.maxScore = score;
        existing.taskDescription = payload.taskDescription ?? existing.taskDescription;
        existing.trajectoryJson = payload.trajectoryJson ?? existing.trajectoryJson;
      }
    }

    // Pass 2: GENERALIZE (best-effort LLM distillation).
    // For each "high frequency" cluster, try to distill a concise
    // one-line description. On any LLM error we fall through to the
    // original description — never block the pass on model failures.
    const highFreqClusters = Array.from(byHash.values()).filter(
      (c) => c.deviceSet.size >= HIGH_FREQUENCY_MIN_DEVICES && c.totalUsage >= HIGH_FREQUENCY_MIN_USAGE
    );
    if (highFreqClusters.length > 0) {
      await tryDistillBatch(highFreqClusters);
    }

    // Pass 3: RANK + top-N truncation.
    const ranked: ConsolidatedLearning[] = Array.from(byHash.values())
      .map((c) => ({
        trajectoryHash: c.trajectoryHash,
        taskDescription: c.taskDescription,
        trajectoryJson: c.trajectoryJson,
        successScore: c.maxScore,
        usageCountFleetwide: c.totalUsage,
        contributingDevices: c.deviceSet.size,
      }))
      .toSorted((a, b) => b.usageCountFleetwide * b.successScore - a.usageCountFleetwide * a.successScore)
      .slice(0, keepTopN);

    const nextVersionRow = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM consolidated_learnings').get() as {
      v: number;
    };
    const version = nextVersionRow.v + 1;
    const publishedAt = Date.now();
    const contributingDeviceCount = new Set(Array.from(byHash.values()).flatMap((c) => Array.from(c.deviceSet))).size;

    db.prepare(
      `INSERT INTO consolidated_learnings (version, published_at, payload, trajectory_count, contributing_devices)
       VALUES (?, ?, ?, ?, ?)`
    ).run(version, publishedAt, JSON.stringify(ranked), ranked.length, contributingDeviceCount);

    // Mark source rows as consumed so the next run only sees new data.
    const allSourceIds = Array.from(byHash.values()).flatMap((c) => c.sourceIds);
    if (allSourceIds.length > 0) {
      const placeholders = allSourceIds.map(() => '?').join(',');
      db.prepare(`UPDATE fleet_learnings SET consolidated_version = ? WHERE id IN (${placeholders})`).run(
        version,
        ...allSourceIds
      );
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
 * Best-effort LLM distillation of task descriptions. Mutates cluster
 * objects in-place so Pass 3 reads the distilled values. Any error
 * short-circuits to "keep the original description" for every cluster
 * in the batch — not per-cluster — because a failing model config
 * will fail every call identically and retrying each one wastes time.
 */
async function tryDistillBatch(clusters: { taskDescription: string }[]): Promise<void> {
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
        const response = await llm.invoke([
          {
            role: 'system',
            content:
              'Distill the following task description into a single concise sentence (max 15 words) capturing the core intent. Output only the distilled sentence — no preamble, no quotes, no markdown.',
          },
          { role: 'user', content: cluster.taskDescription },
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
        const trimmed = text.trim();
        if (trimmed.length > 0 && trimmed.length <= 300) {
          cluster.taskDescription = trimmed;
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
 * Admin-triggered one-shot. Differs from the scheduled version only
 * in that it opens the DB handle itself — IPC caller doesn't need
 * to wire the driver through.
 */
export async function runDreamNow(options?: { keepTopN?: number }): Promise<DreamPassResult> {
  const db = await getDatabase();
  return runDreamPass(db.getDriver(), options);
}
