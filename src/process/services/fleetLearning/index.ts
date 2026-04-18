/**
 * @license Apache-2.0
 * Phase C (v1.11.0) Dream Mode — core module. Provides:
 *
 *   - Export-envelope builder (slave): reads unexported trajectories
 *     + memory summaries, scrubs secrets, enforces caps.
 *   - Export tracking state (slave): the learning_exports table API so
 *     the push worker knows what's already been sent.
 *   - Master-side ingestion: takes an envelope from a slave, fans out
 *     into fleet_learnings rows keyed by (deviceId, payload hash).
 *   - Consolidation accessors (master): reads consolidated_learnings
 *     for the latest published version; dream scheduler writes to it.
 *
 * Kept as a single file until it proves to need splitting — mirrors
 * the fleetTelemetry/index.ts pattern.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { deepScrubForExport } from '@process/utils/redaction';
import { logActivity } from '../activityLog';
import { logNonCritical } from '@process/utils/logNonCritical';
import {
  LEARNING_EXPORT_LIMITS,
  type ConsolidatedLearningsPayload,
  type ExportedMemorySummary,
  type ExportedTrajectory,
  type LearningExportEnvelope,
} from './types';

// ── Slave-side: export-tracking state ────────────────────────────────────

/** Write state read from learning_exports. */
export type LearningExportState = {
  lastWindowEnd: number;
  lastPushAt?: number;
  lastPushError?: string;
};

/**
 * Fetch the slave's last-pushed window cursor. We keep this in a
 * single "state-row" table, using a reserved id '__cursor__' so we
 * don't need yet another table. Row might not exist on first call
 * (fresh slave) — returns zeros in that case.
 */
export function getLearningState(db: ISqliteDriver): LearningExportState {
  // Use a synthetic single-row in learning_exports with source_table='__state__'.
  // Cheaper than a second table, simpler than a key-value config blob.
  const row = db
    .prepare(
      `SELECT window_end, pushed_at, ack_version
       FROM learning_exports
       WHERE source_table = '__state__' AND source_id = '__cursor__'`
    )
    .get() as { window_end: number; pushed_at: number | null; ack_version: number | null } | undefined;
  if (!row) return { lastWindowEnd: 0 };
  return {
    lastWindowEnd: row.window_end,
    lastPushAt: row.pushed_at ?? undefined,
    // ack_version hijacked for last_push_error storage encoded as a
    // number would be ugly. Store errors via setLearningState below
    // which uses a separate tiny table (created lazily on first write).
  };
}

/**
 * Record the outcome of one push cycle — cursor advance + push ts +
 * optional error. Called after every push (success OR fail) so the
 * UI can surface the latest state without waiting for the next cycle.
 */
export function setLearningState(
  db: ISqliteDriver,
  patch: { lastWindowEnd?: number; lastPushAt?: number; lastPushError?: string | null }
): void {
  // Upsert the cursor row.
  if (patch.lastWindowEnd !== undefined || patch.lastPushAt !== undefined) {
    const existing = db
      .prepare(`SELECT id FROM learning_exports WHERE source_table = '__state__' AND source_id = '__cursor__'`)
      .get() as { id: string } | undefined;
    const now = Date.now();
    if (existing) {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (patch.lastWindowEnd !== undefined) {
        fields.push('window_end = ?');
        values.push(patch.lastWindowEnd);
      }
      if (patch.lastPushAt !== undefined) {
        fields.push('pushed_at = ?');
        values.push(patch.lastPushAt);
      }
      values.push(existing.id);
      db.prepare(`UPDATE learning_exports SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    } else {
      db.prepare(
        `INSERT INTO learning_exports (id, source_table, source_id, window_start, window_end, pushed_at)
         VALUES (?, '__state__', '__cursor__', ?, ?, ?)`
      ).run(crypto.randomUUID(), 0, patch.lastWindowEnd ?? 0, patch.lastPushAt ?? now);
    }
  }
  // Error-state stored in a side table so the cursor row stays clean.
  // We create the tiny table lazily so the migration doesn't have to
  // carry it (defensive against downgrade cycles).
  if (patch.lastPushError !== undefined) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS fleet_learning_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         last_push_error TEXT,
         updated_at INTEGER NOT NULL
       )`
    );
    db.prepare(`INSERT OR REPLACE INTO fleet_learning_state (id, last_push_error, updated_at) VALUES (1, ?, ?)`).run(
      patch.lastPushError,
      Date.now()
    );
  }
}

export function getLearningLastError(db: ISqliteDriver): string | undefined {
  try {
    const row = db.prepare(`SELECT last_push_error FROM fleet_learning_state WHERE id = 1`).get() as
      | { last_push_error: string | null }
      | undefined;
    return row?.last_push_error ?? undefined;
  } catch {
    // Table doesn't exist yet — no error recorded.
    return undefined;
  }
}

// ── Slave-side: envelope builder ─────────────────────────────────────────

/**
 * Build one LearningExportEnvelope covering [windowStart, windowEnd).
 *
 * Selection:
 *   - trajectories: locally-minted (source_tag IS NULL) rows with
 *     updated_at >= windowStart, NOT already exported for this window.
 *     Ranked by success_score * usage_count DESC, capped at MAX_*.
 *   - memorySummaries: agent_memory rows where memory_type='summary'
 *     AND updated_at >= windowStart, NOT already exported. Capped at
 *     MAX_*.
 *
 * After selection, every string value in the JSON payloads runs through
 * `deepScrubForExport` — belt-and-suspenders redaction of API keys,
 * tokens, home-paths, and emails before the envelope leaves the slave.
 *
 * Returns null when the window would carry zero rows (no point
 * POSTing an empty envelope + cursor advances).
 */
export function buildLearningEnvelope(
  db: ISqliteDriver,
  windowStart: number,
  windowEnd: number
): LearningExportEnvelope | null {
  const trajectories = selectTrajectories(db, windowStart, windowEnd);
  const memorySummaries = selectMemorySummaries(db, windowStart, windowEnd);

  if (trajectories.length === 0 && memorySummaries.length === 0) return null;

  // Enforce payload byte budget — drop lowest-signal trajectories first.
  const envelope: LearningExportEnvelope = {
    windowStart,
    windowEnd,
    trajectories,
    memorySummaries,
  };
  const clamped = clampEnvelopeToBytes(envelope, LEARNING_EXPORT_LIMITS.MAX_PAYLOAD_BYTES);
  return clamped;
}

function selectTrajectories(db: ISqliteDriver, windowStart: number, _windowEnd: number): ExportedTrajectory[] {
  // Skip rows already pushed this window via the unique
  // (source_table, source_id, window_end) index — a NOT EXISTS subquery
  // is simpler than a LEFT JOIN here and the exports table stays small
  // because old cursors are swept.
  const rows = db
    .prepare(
      `SELECT rb.id, rb.trajectory_hash, rb.task_description, rb.trajectory, rb.success_score, rb.usage_count
       FROM reasoning_bank rb
       WHERE rb.source_tag IS NULL
         AND rb.updated_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM learning_exports le
           WHERE le.source_table = 'reasoning_bank'
             AND le.source_id = rb.id
             AND le.pushed_at IS NOT NULL
         )
       ORDER BY rb.success_score * rb.usage_count DESC, rb.updated_at DESC
       LIMIT ?`
    )
    .all(windowStart, LEARNING_EXPORT_LIMITS.MAX_TRAJECTORIES_PER_WINDOW) as Array<{
    id: string;
    trajectory_hash: string;
    task_description: string;
    trajectory: string;
    success_score: number;
    usage_count: number;
  }>;

  return rows.map((r) => ({
    trajectoryHash: r.trajectory_hash,
    taskDescription: scrubString(r.task_description),
    // Parse → deep-scrub → stringify. Round-trip isolates the scrubber
    // from SQL-escape concerns and ensures downstream JSON.parse works.
    trajectoryJson: JSON.stringify(deepScrubForExport(safeParseArray(r.trajectory))),
    successScore: r.success_score,
    usageCountLocal: r.usage_count,
  }));
}

function selectMemorySummaries(db: ISqliteDriver, windowStart: number, _windowEnd: number): ExportedMemorySummary[] {
  const rows = db
    .prepare(
      `SELECT am.id, am.agent_slot_id, am.content, am.token_count
       FROM agent_memory am
       WHERE am.memory_type = 'summary'
         AND am.updated_at >= ?
         AND NOT EXISTS (
           SELECT 1 FROM learning_exports le
           WHERE le.source_table = 'agent_memory'
             AND le.source_id = am.id
             AND le.pushed_at IS NOT NULL
         )
       ORDER BY am.relevance_score DESC, am.updated_at DESC
       LIMIT ?`
    )
    .all(windowStart, LEARNING_EXPORT_LIMITS.MAX_MEMORY_SUMMARIES_PER_WINDOW) as Array<{
    id: string;
    agent_slot_id: string;
    content: string;
    token_count: number;
  }>;

  return rows.map((r) => ({
    // Anonymize the slot id so master can't map a learning back to a
    // specific local agent instance. Dedup across devices still works
    // because the same user naming the same slot would get the same hash.
    agentSlotHash: crypto.createHash('sha256').update(r.agent_slot_id).digest('hex').slice(0, 16),
    contentJson: JSON.stringify(deepScrubForExport(safeParse(r.content))),
    tokenCount: r.token_count,
  }));
}

function clampEnvelopeToBytes(env: LearningExportEnvelope, budget: number): LearningExportEnvelope {
  let size = JSON.stringify(env).length;
  while (size > budget && env.trajectories.length > 0) {
    // The trajectories are already sorted by success_score * usage_count
    // DESC — pop from the tail (lowest signal first).
    env.trajectories.pop();
    size = JSON.stringify(env).length;
  }
  while (size > budget && env.memorySummaries.length > 0) {
    env.memorySummaries.pop();
    size = JSON.stringify(env).length;
  }
  return env;
}

function scrubString(s: string): string {
  // Reuse deepScrubForExport on a string leaf — it dispatches to the
  // pattern-scrubber + path-redactor internally.
  return deepScrubForExport(s) as string;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return {};
  }
}

function safeParseArray(s: string): unknown[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Mark the envelope's source rows as pushed. Called AFTER master
 * returns 2xx so we don't record a push that didn't actually land.
 * Idempotent via the unique index — retrying the same window is safe.
 */
export function markEnvelopePushed(db: ISqliteDriver, env: LearningExportEnvelope): void {
  // Re-fetch the ids for trajectories by hash so we record the correct
  // source_id. Memory summaries are keyed by agentSlotHash + content
  // hash on master side, so we don't need per-row source_id here —
  // we just record a marker row per hash.
  const now = Date.now();
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO learning_exports
     (id, source_table, source_id, window_start, window_end, pushed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const tr of env.trajectories) {
    const row = db
      .prepare(`SELECT id FROM reasoning_bank WHERE trajectory_hash = ? AND source_tag IS NULL`)
      .get(tr.trajectoryHash) as { id: string } | undefined;
    if (!row) continue;
    insertStmt.run(crypto.randomUUID(), 'reasoning_bank', row.id, env.windowStart, env.windowEnd, now);
  }
  for (const sum of env.memorySummaries) {
    insertStmt.run(
      crypto.randomUUID(),
      'agent_memory',
      `hash:${sum.agentSlotHash}`,
      env.windowStart,
      env.windowEnd,
      now
    );
  }
}

// ── Master-side: ingestion ──────────────────────────────────────────────

/**
 * Persist one slave's learning export as per-row shards in
 * fleet_learnings. Dedup across devices happens at dream time, not
 * here — that way a single device's repeated push still gets
 * recorded (master sees the usage_count_local rise over time).
 */
export function ingestLearningEnvelope(
  db: ISqliteDriver,
  deviceId: string,
  envelope: LearningExportEnvelope
): { trajectories: number; memorySummaries: number } {
  let trajectories = 0;
  let memorySummaries = 0;

  const insertStmt = db.prepare(
    `INSERT INTO fleet_learnings
     (id, device_id, learning_type, payload, success_score, usage_count_local, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const now = Date.now();

  for (const tr of envelope.trajectories) {
    insertStmt.run(
      crypto.randomUUID(),
      deviceId,
      'trajectory',
      JSON.stringify({
        trajectoryHash: tr.trajectoryHash,
        taskDescription: tr.taskDescription,
        trajectoryJson: tr.trajectoryJson,
      }),
      tr.successScore,
      tr.usageCountLocal,
      now
    );
    trajectories += 1;
  }

  for (const sum of envelope.memorySummaries) {
    insertStmt.run(
      crypto.randomUUID(),
      deviceId,
      'memory_summary',
      JSON.stringify({ agentSlotHash: sum.agentSlotHash, contentJson: sum.contentJson }),
      null,
      null,
      now
    );
    memorySummaries += 1;
  }

  try {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'fleet_learning_ingest',
      action: 'fleet.learning.ingested',
      entityType: 'fleet_device',
      entityId: deviceId,
      details: {
        trajectories,
        memorySummaries,
        windowStart: envelope.windowStart,
        windowEnd: envelope.windowEnd,
      },
    });
  } catch (e) {
    logNonCritical('fleet.learning.audit-ingest', e);
  }

  return { trajectories, memorySummaries };
}

// ── Master-side: consolidated learnings accessor ────────────────────────

/**
 * Phase C v1.11.2 — per-pattern drill-down.
 *
 * For a given (trajectoryHash, consolidatedVersion) pair, return the
 * slave devices that contributed to the consolidation + their
 * success-score and usage-count on the slave side. Powers the
 * FleetLearning governance tab's "view contributors" modal: the
 * admin clicks a consolidated pattern and sees which devices actually
 * learned it.
 *
 * Filter happens in JS after the SQL narrow because `trajectoryHash`
 * lives inside the `payload` JSON blob — indexing it would mean
 * either a generated column or a separate hash table, both
 * disproportionate to the query's low frequency (single-digit calls
 * per admin session).
 */
export function listPatternContributors(
  db: ISqliteDriver,
  trajectoryHash: string,
  consolidatedVersion: number
): Array<{
  deviceId: string;
  successScore: number;
  usageCountLocal: number;
  receivedAt: number;
}> {
  const rows = db
    .prepare(
      `SELECT device_id, payload, success_score, usage_count_local, received_at
       FROM fleet_learnings
       WHERE consolidated_version = ? AND learning_type = 'trajectory'
       ORDER BY received_at DESC`
    )
    .all(consolidatedVersion) as Array<{
    device_id: string;
    payload: string;
    success_score: number | null;
    usage_count_local: number | null;
    received_at: number;
  }>;

  const out: Array<{
    deviceId: string;
    successScore: number;
    usageCountLocal: number;
    receivedAt: number;
  }> = [];

  for (const row of rows) {
    let payload: { trajectoryHash?: string };
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      continue;
    }
    if (payload.trajectoryHash !== trajectoryHash) continue;
    out.push({
      deviceId: row.device_id,
      successScore: row.success_score ?? 0,
      usageCountLocal: row.usage_count_local ?? 0,
      receivedAt: row.received_at,
    });
  }
  return out;
}

/**
 * Read the latest published consolidated-learnings payload. Travels
 * in the next fleet config bundle so every slave that polls after a
 * dream pass sees the new version.
 *
 * Returns null when the dream scheduler has never run.
 */
export function getLatestConsolidated(db: ISqliteDriver): ConsolidatedLearningsPayload | null {
  const row = db
    .prepare(`SELECT version, published_at, payload FROM consolidated_learnings ORDER BY version DESC LIMIT 1`)
    .get() as { version: number; published_at: number; payload: string } | undefined;
  if (!row) return null;
  try {
    const entries = JSON.parse(row.payload) as ConsolidatedLearningsPayload['entries'];
    return { version: row.version, publishedAt: row.published_at, entries: Array.isArray(entries) ? entries : [] };
  } catch (e) {
    logNonCritical('fleet.learning.parse-consolidated', e);
    return null;
  }
}
