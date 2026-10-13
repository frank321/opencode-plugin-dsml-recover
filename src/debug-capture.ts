/**
 * Diagnostic capture sink for the DSML leak investigation (LOCAL FORK).
 *
 * Purpose: the shipped plugin logs only per-turn *summaries* (`recovered=N`,
 * `held-candidate-no-call`, `passthrough`). It never records the leaked BYTES,
 * and the specific failure we care about — the 64 KiB over-cap branch in
 * `drain()` — logs nothing at all. So a leak at long context gives us a smoke
 * detector with no smoke.
 *
 * This module is an OBSERVER ONLY. Every call happens *before* the buffer is
 * mutated and never changes what is enqueued, so an instrumented build is
 * behaviourally byte-identical to the shipped one (the passthrough invariant
 * the plugin promises still holds).
 *
 * Output: newline-delimited JSON (NDJSON) at `/tmp/opencode/dsml-capture.log`,
 * one object per event. Fields are sized for a human to grep, not for replay:
 * we keep the head and tail of any held candidate plus its exact length, which
 * is enough to answer "did this fail because the buffer cap was too small, or
 * because the shape was malformed?".
 *
 * Enabled by the `capture` option (see config.ts). Off by default.
 */

import { appendFileSync, mkdirSync } from "node:fs"

/** Directory + file for captures. Created lazily on first write. */
export const CAPTURE_DIR = "/tmp/opencode"
export const CAPTURE_FILE = `${CAPTURE_DIR}/dsml-capture.log`

/** How many head/tail characters of buffered text to record per event. */
const SAMPLE = 600

let ready = false
function ensureDir(): void {
  if (ready) return
  try {
    mkdirSync(CAPTURE_DIR, { recursive: true })
  } catch {
    // Already exists or not creatable; the append below will also fail loudly
    // into the same catch. Best effort only.
  }
  ready = true
}

export interface CaptureRecord {
  /** Event name: drain-decision, over-cap, emit-resolved, delta, etc. */
  ev: string
  /** Which transport produced the event. */
  src: "aisdk" | "sse"
  [key: string]: unknown
}

/**
 * Which path `drain()` is about to take for the current buffer. Recording the
 * *decision* (not just the outcome) is the whole point: the over-cap branch is
 * where a small buffer would cause the leak, and it was previously silent.
 */
export interface DrainDecision {
  /** Full length of the held candidate buffer, in JS string chars. */
  readonly len: number
  /** Configured cap in chars. */
  readonly cap: number
  /** Index where the candidate started inside the buffer (-1 = none). */
  readonly holdStart: number
  /** Whether a complete block closer was seen (resolvable now). */
  readonly closed: boolean
  /** Whether a block opener is pending (open without its closer). */
  readonly hasBlockOpen: boolean
  /** Whether we are inside a `parameter name=` value (long values allowed). */
  readonly insideValue: boolean
  /** Whether len exceeded the cap. */
  readonly overCap: boolean
  /** Whether the eager window was exceeded (prose, not a call). */
  readonly overEager: boolean
  /** Which branch will run. */
  readonly branch:
    | "no-candidate"
    | "partial-opener-hold"
    | "markup-noise-drop"
    | "emit-plain"
    | "resolved-closed"
    | "eager-flush"
    | "hold-continue"
    | "overcap-flush"
    | "resolved-final"
  readonly final: boolean
}

/** First/last SAMPLE chars of a string, plus its true length. */
function sample(text: string): { len: number; head: string; tail: string; truncated: boolean } {
  const len = text.length
  if (len <= SAMPLE * 2) return { len, head: text, tail: "", truncated: false }
  return { len, head: text.slice(0, SAMPLE), tail: text.slice(-SAMPLE), truncated: true }
}

/**
 * Write one NDJSON record. Never throws into the caller: a diagnostic must not
 * be able to break inference (same contract as the plugin's own `log()`).
 */
export function capture(enabled: boolean, record: CaptureRecord): void {
  if (!enabled) return
  try {
    ensureDir()
    appendFileSync(CAPTURE_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
  } catch {
    // best effort — a diagnostic never breaks the stream.
  }
}

/** Convenience: a drain decision plus the buffered bytes it applies to. */
export function captureDrain(
  enabled: boolean,
  src: "aisdk" | "sse",
  decision: DrainDecision,
  buffer: string,
  extra?: Record<string, unknown>,
): void {
  if (!enabled) return
  capture(enabled, {
    ev: "drain",
    src,
    ...decision,
    buf: sample(buffer),
    ...extra,
  })
}

/** Emitted whenever text is flushed as visible output (the leak boundary). */
export function captureEmit(
  enabled: boolean,
  src: "aisdk" | "sse",
  reason: string,
  text: string,
  extra?: Record<string, unknown>,
): void {
  if (!enabled) return
  capture(enabled, { ev: "emit", src, reason, text: sample(text), ...extra })
}

/**
 * Per-delta size trace. Kept deliberately cheap: only the running buffer length
 * and the incoming delta length, so we can see whether a leak EVER approached
 * the cap. If leaks happen at ~200 chars, the small-buffer theory is dead; if
 * they cluster just under 64 KiB, the cap is implicated.
 */
export function captureDelta(
  enabled: boolean,
  src: "aisdk" | "sse",
  bufferLen: number,
  deltaLen: number,
  cap: number,
): void {
  if (!enabled) return
  capture(enabled, { ev: "delta", src, bufferLen, deltaLen, cap })
}
