/**
 * @license Apache-2.0
 * ResponseStreamBuffer — per-conversation text accumulator + finalized-turn tracker.
 *
 * Extracted from TeammateManager (Phase 3.2) to isolate the stream-accumulation
 * state. TeammateManager.handleResponseStream() previously owned:
 *   - `responseBuffer: Map<convId, string>` — accumulated streamed text
 *   - `finalizedTurns: Set<convId>` — dedup guard against double-finalization
 *   - ad-hoc provider payload normalization (plain string / {text} / {content})
 *   - the memory sweeper that dropped buffers for non-active agents
 *
 * Those four responsibilities now live here as a single cohesive collaborator.
 * TeammateManager delegates reads/writes rather than owning the maps directly.
 *
 * Additions layered on top of the extraction:
 *   - bounded growth via `maxBytes` (default TEAM_CONFIG.RESPONSE_BUFFER_MAX_BYTES)
 *     with oldest-first truncation. Previously the buffer could accumulate
 *     unboundedly if a turn never finalized — this is the fix for the class of
 *     leaks the Phase 2 memory sweeper was only partially catching.
 */

import { TEAM_CONFIG } from './config';

export type ResponseStreamBufferOptions = {
  /** Hard cap on bytes per conversation. Oldest bytes are dropped on overflow. */
  maxBytes?: number;
};

export class ResponseStreamBuffer {
  private readonly buffers = new Map<string, string>();
  private readonly finalized = new Set<string>();
  private readonly maxBytes: number;

  constructor(opts: ResponseStreamBufferOptions = {}) {
    this.maxBytes = opts.maxBytes ?? TEAM_CONFIG.RESPONSE_BUFFER_MAX_BYTES;
  }

  // ── Accumulation ─────────────────────────────────────────────────────────

  /**
   * Append a raw string chunk. Empty strings are dropped to match the
   * long-standing guard in TeammateManager.handleResponseStream().
   */
  append(conversationId: string, chunk: string): void {
    if (!chunk) return;
    const existing = this.buffers.get(conversationId) ?? '';
    const merged = existing + chunk;
    this.buffers.set(conversationId, this.trim(merged));
  }

  /**
   * Append a provider payload. Accepts:
   *   - plain string
   *   - { text: string }
   *   - { content: string }
   *
   * Anything else is silently ignored (matches TeammateManager's tolerant
   * multi-shape decoder). Returns the normalized string that was appended,
   * or undefined if nothing was appended.
   */
  appendNormalized(conversationId: string, payload: unknown): string | undefined {
    const text = this.normalize(payload);
    if (text === undefined || text.length === 0) return undefined;
    this.append(conversationId, text);
    return text;
  }

  /** Normalize a provider payload to a string, or undefined if unrecognized. */
  normalize(payload: unknown): string | undefined {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.content === 'string') return record.content;
    }
    return undefined;
  }

  // ── Retrieval / reset ───────────────────────────────────────────────────

  /**
   * Destructively read the accumulated text for a conversation. Subsequent
   * append() calls start a fresh buffer.
   */
  take(conversationId: string): string {
    const value = this.buffers.get(conversationId) ?? '';
    this.buffers.delete(conversationId);
    return value;
  }

  /** Inspect without consuming. */
  peek(conversationId: string): string {
    return this.buffers.get(conversationId) ?? '';
  }

  /** Drop a single conversation's buffer. */
  clear(conversationId: string): void {
    this.buffers.delete(conversationId);
  }

  /** Start a fresh buffer for a conversation (called at wake start). */
  resetFor(conversationId: string): void {
    this.buffers.set(conversationId, '');
  }

  // ── Finalized-turn tracking ─────────────────────────────────────────────

  markFinalized(conversationId: string): void {
    this.finalized.add(conversationId);
  }

  isFinalized(conversationId: string): boolean {
    return this.finalized.has(conversationId);
  }

  unmarkFinalized(conversationId: string): void {
    this.finalized.delete(conversationId);
  }

  /**
   * Force-clear the finalized set. Mirrors the sweepMemory() pass in
   * TeammateManager: any remaining entry after the 5s self-clear timer
   * is considered leaked.
   */
  clearFinalizedExpired(): void {
    this.finalized.clear();
  }

  // ── Memory sweep (called from the periodic sweeper) ─────────────────────

  /**
   * Drop buffers whose conversationId is not in the active set. Mirrors
   * the loop in TeammateManager.sweepMemory() so the god-object split
   * preserves leak-prevention behavior.
   */
  sweep(activeConversationIds: ReadonlySet<string>): void {
    for (const convId of this.buffers.keys()) {
      if (!activeConversationIds.has(convId)) {
        this.buffers.delete(convId);
      }
    }
  }

  /** Current number of buffered conversations — useful for metrics. */
  size(): number {
    return this.buffers.size;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private trim(s: string): string {
    if (s.length <= this.maxBytes) return s;
    // Overflow: keep the tail (most recent content) — matches the general
    // expectation that the most recent output is what the turn finalizer needs.
    return s.slice(s.length - this.maxBytes);
  }
}
