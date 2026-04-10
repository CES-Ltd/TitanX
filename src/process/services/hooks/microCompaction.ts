/**
 * Micro-Compaction — selective truncation of stale tool results.
 *
 * Unlike full compaction which summarizes the entire conversation,
 * micro-compaction only truncates verbose tool outputs from older turns.
 * This preserves conversation flow while preventing context overflow.
 *
 * Inspired by open-claude-code's selective compaction strategy.
 */

/** Maximum age in turns before tool results get truncated. */
const STALE_TURN_THRESHOLD = 5;
/** Maximum chars to keep from a truncated tool result. */
const TRUNCATED_PREVIEW_LENGTH = 200;
/** Minimum total chars before micro-compaction kicks in. */
const MIN_TOTAL_CHARS = 30_000;

export type Message = {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * Apply micro-compaction to a message array.
 * Truncates tool results older than STALE_TURN_THRESHOLD turns.
 * Returns a new array (does not mutate input).
 */
export function microCompact(messages: Message[]): { messages: Message[]; truncatedCount: number; savedChars: number } {
  const totalChars = messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);

  // Only compact if total context is large enough
  if (totalChars < MIN_TOTAL_CHARS) {
    return { messages, truncatedCount: 0, savedChars: 0 };
  }

  const totalMessages = messages.length;
  let truncatedCount = 0;
  let savedChars = 0;

  const result = messages.map((msg, idx) => {
    const turnsFromEnd = totalMessages - idx;

    // Only truncate old tool results
    if (turnsFromEnd <= STALE_TURN_THRESHOLD) return msg;
    if (msg.role !== 'tool' && msg.role !== 'function') return msg;

    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    if (content.length <= TRUNCATED_PREVIEW_LENGTH * 2) return msg; // Already short enough

    const preview = content.slice(0, TRUNCATED_PREVIEW_LENGTH);
    const truncated = `${preview}\n\n[... truncated ${String(content.length - TRUNCATED_PREVIEW_LENGTH)} chars — tool result from ${String(turnsFromEnd)} turns ago ...]`;

    truncatedCount++;
    savedChars += content.length - truncated.length;

    return { ...msg, content: truncated };
  });

  if (truncatedCount > 0) {
    console.log(
      `[MicroCompact] Truncated ${String(truncatedCount)} stale tool results, saved ${String(savedChars)} chars (${String(Math.round((savedChars / totalChars) * 100))}% reduction)`
    );
  }

  return { messages: result, truncatedCount, savedChars };
}
