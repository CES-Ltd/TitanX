/**
 * Caveman Mode — Token-saving system prompt injection.
 * Reduces LLM output tokens 30-75% by enforcing terse formatting rules.
 * Based on https://github.com/JuliusBrussee/caveman
 */

export type CavemanMode = 'off' | 'lite' | 'full' | 'ultra';

export const CAVEMAN_PROMPTS: Record<Exclude<CavemanMode, 'off'>, string> = {
  lite: `COMMUNICATION STYLE: Concise Professional
- Drop filler words (just, really, basically, actually, pretty much)
- Drop hedging (I think, maybe, perhaps, it seems like)
- No pleasantries or preamble. No "Sure!", "Great question!", "I'll now..."
- Short sentences. Direct statements. One idea per line.
- Keep grammar correct. Keep articles (a/an/the).
- All technical terms exact. Code blocks unchanged.
- Never repeat what the user said. Never summarize what you're about to do.`,

  full: `COMMUNICATION STYLE: Caveman Mode (Token Saving Active)
- Drop articles (a/an/the). Drop filler. Drop pleasantries.
- Fragments OK. No full sentences needed.
- Short synonyms: big not extensive, use not utilize, fast not expeditious, fix not resolve
- Pattern: [thing] [action] [reason]. [next step].
- Technical terms exact. Code blocks unchanged.
- Never say "I'll", "Let me", "Sure!", "Great question!", "I'd be happy to"
- No transition phrases. No meta-commentary. Just content.
- Lists over paragraphs. Bullets over prose.`,

  ultra: `COMMUNICATION STYLE: ULTRA COMPRESSED (Maximum Token Saving)
- Abbreviate: DB/auth/config/req/res/fn/impl/deps/env/repo/dir/pkg/msg/err/val/obj/arr/str/num/bool/param/ret/async/sync
- Drop articles, conjunctions, prepositions where parseable
- Arrows: X -> Y. Pipes: A | B. Slashes: read/write
- Max 5 words per line where possible
- No prose. Lists and fragments only.
- Technical terms exact. Code blocks unchanged.
- NEVER explain what you're about to do. Just do it.
- No filler. No hedging. No preamble. No summary. Just answer.
- Use symbols: + (add), - (remove), ~ (change), ! (important), ? (question)`,
};

/** Estimated output token savings ratio by mode. */
export const SAVINGS_RATIOS: Record<Exclude<CavemanMode, 'off'>, number> = {
  lite: 0.3,
  full: 0.65,
  ultra: 0.75,
};

/**
 * Get the caveman prompt prefix for the given mode.
 * Returns empty string for 'off'.
 */
export function getCavemanPromptPrefix(mode: CavemanMode): string {
  if (mode === 'off') return '';
  return `\n\n${CAVEMAN_PROMPTS[mode]}\n\n`;
}

/**
 * Estimate the regular (non-caveman) output token count from caveman output.
 * Uses the savings ratio to back-calculate what the output would have been.
 */
export function estimateRegularTokens(cavemanOutputTokens: number, mode: Exclude<CavemanMode, 'off'>): number {
  const ratio = SAVINGS_RATIOS[mode];
  return Math.round(cavemanOutputTokens / (1 - ratio));
}
