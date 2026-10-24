/**
 * Degenerate-repetition guard (loop detector).
 *
 * A SECOND failure mode, distinct from the DSML markup leak this plugin was
 * built for (found 2026-10-23 on DeepSeek V4.1 via DeepInfra at ~520k cached
 * context; see `docs/PATTERNS.md` §6):
 *
 *   "Let me update the Q31 entry… Let me find Q31's end. Let me check the
 *    current Q31 text. Let me look. Let me grep. Let me do it. Let me check…"
 *
 * The model collapses into re-emitting the same sentence — sometimes alongside
 * a valid tool call, sometimes with `finish=stop` and NO tool call at all. The
 * DSML parser never fires here: there is no markup, so every turn is logged
 * `passthrough` and the loop runs until the user intervenes. This module is the
 * missing detector.
 *
 * Scope and safety: the plugin's invariant is "never break normal inference", so
 * the detector is deliberately CONSERVATIVE. It fires only on a long text block
 * that is overwhelmingly one repeated line, or a long block with a near-flat
 * vocabulary. Prose, code, tables, and logs never trip it — status output and
 * markdown lists have high line diversity even when long. When in doubt it
 * declines.
 *
 * Pure and dependency-free so it is cheap to unit-test against real corpora.
 */

export interface LoopSignal {
  /** Whether degenerate repetition was detected. */
  readonly looping: boolean
  /** Which signal fired: `"line-repeat"` or `"low-unique"`. */
  readonly reason?: "line-repeat" | "low-unique"
  /** Repetition count of the most common line (line-repeat path). */
  readonly repeats?: number
  /** Unique-line ratio in [0,1] (0 = every line identical). */
  readonly uniqueRatio?: number
  /** Character length of the text that was examined. */
  readonly length: number
}

/** Below this length we never call something a loop (short turns are noisy). */
const MIN_LENGTH = 300

/**
 * A single non-blank line repeated at least this many times is degenerate. The
 * real corpus repeats "Let me do it." 39–100× within one block; 8 is far below
 * any legitimate document (a repeated separator line never reaches 8 identical
 * prose lines).
 */
const MIN_LINE_REPEATS = 8

/**
 * Low-unique alternative: on a long block, if fewer than this fraction of lines
 * are distinct, it is a loop. Catches a rotating handful of «Let me do it» /
 * «OK.» / «Running:» lines that individually might not hit MIN_LINE_REPEATS.
 */
const MIN_UNIQUE_RATIO = 0.15

/** Blocks shorter than this only qualify via the strict line-repeat path. */
const LONG_LENGTH = 800

/** Normalise a line for comparison: collapse whitespace, drop list/punct noise. */
function normLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*+>\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/**
 * Classify a text block. Returns the signal (never throws). A block is only
 * ever reported `looping` when it is both long enough AND repetitive enough;
 * otherwise `{ looping: false, length }`.
 */
export function detectLoop(text: string): LoopSignal {
  const length = text.length
  if (length < MIN_LENGTH) return { looping: false, length }

  const lines = text.split("\n").map(normLine).filter((line) => line.length > 0)
  if (lines.length < MIN_LINE_REPEATS) return { looping: false, length }

  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let maxRepeats = 0
  for (const n of counts.values()) if (n > maxRepeats) maxRepeats = n
  const uniqueRatio = counts.size / lines.length

  if (maxRepeats >= MIN_LINE_REPEATS) {
    return { looping: true, reason: "line-repeat", repeats: maxRepeats, uniqueRatio, length }
  }
  if (length >= LONG_LENGTH && uniqueRatio < MIN_UNIQUE_RATIO) {
    return { looping: true, reason: "low-unique", repeats: maxRepeats, uniqueRatio, length }
  }
  return { looping: false, repeats: maxRepeats, uniqueRatio, length }
}

/** Convenience boolean form. */
export function isLooping(text: string): boolean {
  return detectLoop(text).looping
}

/**
 * Collapse a degenerate block to a bounded, human-meaningful summary instead of
 * echoing tens of kilobytes of filler. Called ONLY when `detectLoop` fired, so
 * a normal text block is never rewritten. Keeps the leading intent line (the
 * genuinely-new content at the top, e.g. "Now let me update the Q31 entry…") and
 * replaces the repeated tail with one marker.
 */
export function collapseLoop(text: string, signal?: LoopSignal): string {
  const marker = `\n\n[loop suppressed${signal?.repeats ? `: line repeated ${signal.repeats}×` : ""}]\n`
  // Keep the first paragraph, which is usually the real message; cap it so a
  // pathological block cannot smuggle the filler back in through the head.
  const head = text.split(/\n\s*\n/)[0]?.trim() ?? ""
  const kept = head.length > 400 ? head.slice(0, 400) + "…" : head
  return kept.length > 0 ? kept + marker : marker.trimStart()
}
