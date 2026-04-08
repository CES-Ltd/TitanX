/**
 * @license Apache-2.0
 * Agent memory service — persistent conversation memory inspired by LangChain.
 * Supports buffer, summary, entity, and long-term memory types.
 */

import crypto from 'crypto';
import type { ISqliteDriver } from '../database/drivers/ISqliteDriver';
import { logActivity } from '../activityLog';
import { startSpan } from '../telemetry';

export type MemoryType = 'buffer' | 'summary' | 'entity' | 'long_term';

export type AgentMemoryEntry = {
  id: string;
  agentSlotId: string;
  teamId: string;
  memoryType: MemoryType;
  content: Record<string, unknown>;
  tokenCount: number;
  relevanceScore: number;
  createdAt: number;
  updatedAt: number;
};

/** Add content to an agent's buffer memory */
export function addToBuffer(
  db: ISqliteDriver,
  agentSlotId: string,
  teamId: string,
  content: Record<string, unknown>,
  tokenCount: number
): AgentMemoryEntry {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO agent_memory (id, agent_slot_id, team_id, memory_type, content, token_count, relevance_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1.0, ?, ?)'
  ).run(id, agentSlotId, teamId, 'buffer', JSON.stringify(content), tokenCount, now, now);

  return {
    id,
    agentSlotId,
    teamId,
    memoryType: 'buffer',
    content,
    tokenCount,
    relevanceScore: 1.0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Store a summary (replaces old buffer entries) */
export function storeSummary(
  db: ISqliteDriver,
  agentSlotId: string,
  teamId: string,
  summary: string,
  tokenCount: number
): AgentMemoryEntry {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO agent_memory (id, agent_slot_id, team_id, memory_type, content, token_count, relevance_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0.8, ?, ?)'
  ).run(id, agentSlotId, teamId, 'summary', JSON.stringify({ summary }), tokenCount, now, now);

  logActivity(db, {
    userId: 'system_default_user',
    actorType: 'system',
    actorId: 'agent_memory',
    action: 'agent_memory.summarized',
    entityType: 'agent_memory',
    entityId: id,
    agentId: agentSlotId,
    details: { tokenCount, teamId },
  });

  return {
    id,
    agentSlotId,
    teamId,
    memoryType: 'summary',
    content: { summary },
    tokenCount,
    relevanceScore: 0.8,
    createdAt: now,
    updatedAt: now,
  };
}

/** Retrieve relevant memories for an agent, ranked by recency and relevance */
export function retrieveRelevant(db: ISqliteDriver, agentSlotId: string, limit = 10): AgentMemoryEntry[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_memory WHERE agent_slot_id = ? ORDER BY relevance_score DESC, updated_at DESC LIMIT ?'
    )
    .all(agentSlotId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/** List all memories for an agent, optionally filtered by type */
export function listMemories(db: ISqliteDriver, agentSlotId: string, memoryType?: string): AgentMemoryEntry[] {
  if (memoryType) {
    return (
      db
        .prepare('SELECT * FROM agent_memory WHERE agent_slot_id = ? AND memory_type = ? ORDER BY updated_at DESC')
        .all(agentSlotId, memoryType) as Array<Record<string, unknown>>
    ).map(rowToMemory);
  }
  return (
    db.prepare('SELECT * FROM agent_memory WHERE agent_slot_id = ? ORDER BY updated_at DESC').all(agentSlotId) as Array<
      Record<string, unknown>
    >
  ).map(rowToMemory);
}

/** Prune old buffer entries to stay within token budget */
export function pruneMemory(db: ISqliteDriver, agentSlotId: string, maxTokens: number): number {
  const span = startSpan('titanx.memory', 'agent_memory.prune', { agent_slot_id: agentSlotId });
  const totalRow = db
    .prepare(
      'SELECT COALESCE(SUM(token_count), 0) as total FROM agent_memory WHERE agent_slot_id = ? AND memory_type = ?'
    )
    .get(agentSlotId, 'buffer') as { total: number };

  let pruned = 0;
  if (totalRow.total > maxTokens) {
    // Delete oldest buffer entries until under budget
    const excess = totalRow.total - maxTokens;
    const oldEntries = db
      .prepare(
        'SELECT id, token_count FROM agent_memory WHERE agent_slot_id = ? AND memory_type = ? ORDER BY created_at ASC'
      )
      .all(agentSlotId, 'buffer') as Array<{ id: string; token_count: number }>;

    let removed = 0;
    for (const entry of oldEntries) {
      if (removed >= excess) break;
      db.prepare('DELETE FROM agent_memory WHERE id = ?').run(entry.id);
      removed += entry.token_count;
      pruned++;
    }
  }

  if (pruned > 0) {
    logActivity(db, {
      userId: 'system_default_user',
      actorType: 'system',
      actorId: 'agent_memory',
      action: 'agent_memory.pruned',
      entityType: 'agent_memory',
      agentId: agentSlotId,
      details: { pruned, maxTokens },
    });
  }

  span.setStatus('ok');
  span.end();
  return pruned;
}

/** Clear all memory for an agent */
export function clearMemory(db: ISqliteDriver, agentSlotId: string, memoryType?: string): number {
  if (memoryType) {
    return db
      .prepare('DELETE FROM agent_memory WHERE agent_slot_id = ? AND memory_type = ?')
      .run(agentSlotId, memoryType).changes;
  }
  return db.prepare('DELETE FROM agent_memory WHERE agent_slot_id = ?').run(agentSlotId).changes;
}

/** Get memory stats for an agent */
export function getMemoryStats(db: ISqliteDriver, agentSlotId: string): { totalEntries: number; totalTokens: number } {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt, COALESCE(SUM(token_count), 0) as tokens FROM agent_memory WHERE agent_slot_id = ?'
    )
    .get(agentSlotId) as { cnt: number; tokens: number };
  return { totalEntries: row.cnt, totalTokens: row.tokens };
}

function rowToMemory(row: Record<string, unknown>): AgentMemoryEntry {
  return {
    id: row.id as string,
    agentSlotId: row.agent_slot_id as string,
    teamId: row.team_id as string,
    memoryType: row.memory_type as MemoryType,
    content: JSON.parse((row.content as string) || '{}'),
    tokenCount: (row.token_count as number) ?? 0,
    relevanceScore: (row.relevance_score as number) ?? 1.0,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
