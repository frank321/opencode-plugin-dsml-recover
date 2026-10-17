/**
 * Parse DSML tool-call blocks out of assistant text.
 *
 * Returns the recovered calls plus every character range that should be removed from
 * the text, so a caller can both execute the calls and leave a clean transcript.
 * Shared by the streaming middleware and the stored-transcript repair path
 * (see `docs/PATTERNS.md` §4). Every behaviour maps to `docs/TEST-MATRIX.md`.
 */

import {
  bareValueParameterRe,
  BLOCK_TAG,
  blockCloseRe,
  blockOpenRe,
  danglingMarkerRe,
  endOfSentenceRe,
  invokeCloseRe,
  invokeOpenRe,
  looksLikeDsml,
  MARKER,
  orphanInvokeRe,
  orphanParameterRe,
  parameterLooseRe,
  parameterRe,
  wrappedToolRe,
} from "./grammar.ts"

export interface DsmlToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface Range {
  start: number
  end: number
}

export interface ParseResult {
  calls: DsmlToolCall[]
  /** Ranges to delete from the text, sorted and non-overlapping. */
  ranges: Range[]
}

const EMPTY: ParseResult = { calls: [], ranges: [] }

export interface ParseOptions {
  /** Recover `invoke` blocks with no outer opener (V9). Default true. */
  readonly orphanInvoke?: boolean
  /** Tolerant re-scan when a value ran past a broken closer (V11). Default true. */
  readonly looseParameters?: boolean
  /** Bare-`{…}` invoke body parsed as JSON (V25). Default true. */
  readonly rawJsonBody?: boolean
  /**
   * Recover a wrapped tool call: orphan `<parameter name="X">` (marker optional)
   * containing complete inner parameters (V26, the dominant real-world shape).
   * Default true.
   */
  readonly wrappedTool?: boolean
  /**
   * Recover a bare-value orphan parameter (V27, §22 real leak): orphan
   * `<parameter name="X">VALUE</parameter>` with NO inner children, followed by
   * an orphan invoke/block closer. Default true.
   *
   * Unlike V26, the argument KEY is not in the bytes, so recovery needs a
   * schema-derived key from `resolveBareValueKey`. Without a resolver this
   * rescue declines (falls through to redaction) — it never guesses.
   */
  readonly bareValueTool?: boolean
  /**
   * Resolve the single argument key for `toolName` when a bare-value orphan
   * parameter (V27) is found. Return the key ONLY when the tool's schema has
   * exactly one required string argument (e.g. `shell`→`"command"`). Return
   * `undefined` to decline — a recovered call with a guessed wrong key is worse
   * than a redaction, so an unresolvable key must NOT be invented (§3.D).
   *
   * The parser itself has no tool schema; the caller (middleware, which knows
   * the session's tools) supplies this. Absent → V27 is disabled.
   */
  readonly resolveBareValueKey?: (toolName: string) => string | undefined
}

export function parseDsml(text: string, input?: ParseOptions): ParseResult {
  // NB: explicit `??` defaults, not spread — `{...defaults, ...{flag: undefined}}`
  // would clobber the default with undefined and silently disable the rescue.
  const options: Required<ParseOptions> = {
    orphanInvoke: input?.orphanInvoke ?? true,
    looseParameters: input?.looseParameters ?? true,
    rawJsonBody: input?.rawJsonBody ?? true,
    wrappedTool: input?.wrappedTool ?? true,
    bareValueTool: input?.bareValueTool ?? true,
    resolveBareValueKey: input?.resolveBareValueKey ?? (() => undefined),
  }
  if (!looksLikeDsml(text)) return EMPTY

  const calls: DsmlToolCall[] = []
  const ranges: Range[] = []

  const blockOpens = matchAll(text, blockOpenRe())
  for (const open of blockOpens) {
    if (insideCodeFence(text, open.start)) continue

    const bodyStart = open.end
    const close = firstMatch(text, blockCloseRe(), bodyStart)
    // A truncated response can end mid-block. Parse only up to the last `</invoke>`
    // so a half-written call is never recovered, but strip to the end — nothing
    // after an unclosed block is prose. (V15)
    const bodyEnd = close ? close.start : (lastMatch(text, invokeCloseRe(), bodyStart)?.end ?? bodyStart)

    calls.push(...parseInvokes(text.slice(bodyStart, bodyEnd), options))
    ranges.push({ start: open.start, end: close ? close.end : text.length })
  }

  // Orphan/incomplete forms: an invoke with no block, or a parameter with no invoke,
  // or a runaway name. We already consumed every real block, so scan the *remaining*
  // text for invoke/parameter markers that were not inside a block. (V9, V10, V12)
  // Disabled in strict mode: only complete blocks are trusted there.
  // NB: orphans skip only REAL block ranges. Orphan ranges added by earlier orphans
  // must not shadow later ones — the wrapped-tool rescue (V26) starts at the same
  // offset as its outer orphan-parameter range and would otherwise be skipped.
  const blockRanges = [...ranges]
  const insideBlock = (index: number) => blockRanges.some((r) => index >= r.start && index < r.end)
  if (options.orphanInvoke) {
    for (const orphan of findOrphans(text, options)) {
      if (insideBlock(orphan.start)) continue
      if (insideCodeFence(text, orphan.start)) continue
      ranges.push({ start: orphan.start, end: orphan.end })
      calls.push(...orphan.calls)
    }
  }

  // Markers that never formed a usable block (stray opens, orphan closers) are still
  // noise in the transcript. (V10 remainder, V12 remainder)
  for (const marker of matchAll(text, danglingMarkerRe())) {
    if (insideCodeFence(text, marker.start)) continue
    if (ranges.some((r) => marker.start >= r.start && marker.start < r.end)) continue
    ranges.push(marker)
  }

  for (const eos of matchAll(text, endOfSentenceRe())) {
    if (insideCodeFence(text, eos.start)) continue
    ranges.push(eos)
  }

  if (calls.length === 0 && ranges.length === 0) return EMPTY
  return { calls, ranges: mergeRanges(ranges) }
}

/** Remove `ranges` from `text` and tidy the whitespace they leave behind. */
export function stripRanges(text: string, ranges: Range[]): string {
  let result = ""
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) result += text.slice(cursor, range.start)
    cursor = Math.max(cursor, range.end)
  }
  result += text.slice(cursor)
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Short inline note left where history markup was redacted (never marker bytes). */
export function redactionNote(toolNames: string[]): string {
  const names = [...new Set(toolNames)].filter(Boolean).slice(0, 3).join(",")
  return names.length > 0 ? `[removed malformed ${names} call]` : "[removed malformed markup]"
}

/**
 * Remove `ranges` from `text`, leaving a short inline note so the transcript
 * records that something was tried and dropped — without keeping the broken
 * markup as an example for future calls to imitate. The note is placed at the
 * FIRST removed span only; remaining spans are removed silently, so one message
 * yields one note even when several fragments are stripped.
 * The note must never contain marker bytes (asserted by tests).
 */
export function stripRangesWithNote(text: string, ranges: Range[], note?: string): string {
  const marker = note ?? "[malformed tool call removed]"
  let result = ""
  let cursor = 0
  let noted = false
  for (const range of ranges) {
    if (range.start > cursor) result += text.slice(cursor, range.start)
    if (!noted) {
      result += marker
      noted = true
    }
    cursor = Math.max(cursor, range.end)
  }
  result += text.slice(cursor)
  return result
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface Orphan extends Range {
  calls: DsmlToolCall[]
}

/**
 * Find invoke/parameter fragments that appear outside a complete block. This is the
 * exact degradation in the user's session DB: the outer `tool_calls` opener and the
 * proper `invoke` opener are missing, leaving an orphan `<parameter name="edit">`.
 *
 * A true orphan `invoke` yields a call; a bare `parameter` has no tool name so it only
 * produces a range (strip the noise, execute nothing) — see PATTERNS.md V10 note.
 */
function findOrphans(text: string, options: Required<ParseOptions>): Orphan[] {
  const orphans: Orphan[] = []

  // Orphan invokes with a body: `<BAR DSML BAR invoke name="x">…`.
  for (const open of matchAll(text, orphanInvokeRe())) {
    const name = open.groups[0]?.trim()
    const body = open.groups[1] ?? ""
    const args = parseParameters(body, options)
    const calls = name && Object.keys(args).length > 0 ? [{ name, arguments: args }] : []
    orphans.push({ start: open.start, end: open.end, calls })
  }

  // Orphan parameters (no invoke): range the tag *and* the leaked value body so the
  // transcript is clean. No call is produced — there is no tool name. (V10)
  const parameterBodies = matchAll(text, orphanParameterRe())
  for (const p of parameterBodies) {
    orphans.push({ start: p.start, end: p.end, calls: [] })
  }

  // Wrapped tool calls (V26): orphan `<parameter name="X">` containing complete
  // inner parameters. The nesting is the authenticity signal — plain prose never
  // contains marker-tagged children. Recovers the dominant real-world shape.
  // Requires at least one STRICT-complete inner parameter: a half-written inner
  // value must not become a call (V16 philosophy).
  //
  // Ranges claimed here are collected separately so the V27 bare-value rescue can
  // skip ONLY genuine V26 matches — not the orphan-parameter ranges pushed above
  // (which cover the same element and would otherwise mask every V27 candidate).
  const wrappedRanges: Range[] = []
  if (options.wrappedTool) {
    for (const w of matchAll(text, wrappedToolRe())) {
      const name = w.groups[0]?.trim()
      if (!name) continue
      const body = w.groups[1] ?? ""
      if (matchAll(body, parameterRe()).length === 0) continue
      const args = parseParameters(body, options)
      if (Object.keys(args).length === 0) continue
      orphans.push({ start: w.start, end: w.end, calls: [{ name, arguments: args }] })
      wrappedRanges.push({ start: w.start, end: w.end })
    }
  }

  // Bare-value orphan parameter (V27, §22 real leak): `<parameter name="X">VALUE
  // </parameter>` with NO inner children, closed by a real `</parameter>` AND
  // followed by an orphan invoke/block closer. The grammar's closer requirement
  // is the authenticity signal; recovery then needs a KEY for VALUE, which the
  // bytes do not carry. The caller supplies one via `resolveBareValueKey`
  // (schema-derived). If no key resolves, this DECLINES and emits no call — a
  // wrong key is worse than a redaction (§3.D). Only bodies WITHOUT inner
  // marker-tagged params reach here (V26 already claimed those).
  if (options.bareValueTool) {
    // Skip only genuine V26 (wrapped-tool) matches — not the orphan-parameter
    // ranges, which cover the same element and would mask every V27 candidate.
    const overlapsV26 = (start: number, end: number) =>
      wrappedRanges.some((r) => start < r.end && end > r.start)
    for (const b of matchAll(text, bareValueParameterRe())) {
      if (overlapsV26(b.start, b.end)) continue
      const name = b.groups[0]?.trim()
      if (!name) continue
      const body = b.groups[1] ?? ""
      // V26 territory: a body with complete inner params is not a bare value.
      if (matchAll(body, parameterRe()).length > 0) continue
      // The closer regex already fired in the grammar; nothing to strip without a key.
      const key = options.resolveBareValueKey(name)
      if (!key) continue
      const value = decodeValue(body.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), undefined)
      if (typeof value !== "string" || value.length === 0) continue
      // Swallow an immediately-following orphan invoke/block closer so a bare
      // closer (e.g. a lone invoke end, or a mangled calls end) does not survive
      // as visible markup. Both real leaks ended with one. Only whitespace may
      // sit between the parameter close and the closer.
      const afterCloser = new RegExp(
        `^[ \\t\\r\\n]*</(?:${MARKER})?(?:invoke|${BLOCK_TAG})[ \\t\\r\\n]*>`,
        "iu",
      ).exec(text.slice(b.end))
      const end = afterCloser ? b.end + afterCloser[0].length : b.end
      orphans.push({ start: b.start, end, calls: [{ name, arguments: { [key]: value } }] })
    }
  }

  return orphans
}

function parseInvokes(body: string, options: Required<ParseOptions>): DsmlToolCall[] {
  const calls: DsmlToolCall[] = []
  const opens = matchAll(body, invokeOpenRe())

  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]!
    const name = open.groups[0]?.trim()
    if (!name) continue // V14: empty or runaway name

    // Prefer the real closing tag; otherwise stop at the next invoke so a truncated
    // tail does not swallow the following call. (V11, V16)
    const close = firstMatch(body, invokeCloseRe(), open.end)
    const nextOpen = opens[i + 1]
    const end = close && (!nextOpen || close.start < nextOpen.start) ? close.start : (nextOpen?.start ?? body.length)

    const args = parseParameters(body.slice(open.end, end), options)
    if (Object.keys(args).length === 0) continue // reject-empty-args
    calls.push({ name, arguments: args })
  }

  return calls
}

function parseParameters(body: string, options: Required<ParseOptions>): Record<string, unknown> {
  const strict = collectParameters(body, parameterRe())
  // If the strict scan produced nothing, or one value ran away into the next
  // parameter (the vLLM mis-closed-closer leak), retry with the tolerant scan. (V11)
  // The tolerant scan applies when `looseParameters` is on; otherwise the
  // strict result stands as-is.
  const ranAway = Object.values(strict).some((value) => typeof value === "string" && value.includes("DSML"))
  const picked =
    options.looseParameters && (Object.keys(strict).length === 0 || ranAway)
      ? collectParameters(body, parameterLooseRe(), true)
      : strict

  if (Object.keys(picked).length > 0) return picked
  if (!options.rawJsonBody) return picked
  // Raw JSON body fallback: an invoke whose body is a bare JSON object. (V25)
  const trimmed = body.trim()
  if (!trimmed.startsWith("{")) return picked
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (isRecord(parsed) && Object.keys(parsed).length > 0) return parsed
  } catch {
    // fall through
  }
  return picked
}

function collectParameters(body: string, re: RegExp, dropRunaway = false): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  // Positions of every mis-spelled closer `</BAR DSML BAR>` in the body. A parameter
  // whose match spans one of these is the vLLM mis-closed leak: its value ran past a
  // broken boundary, so it cannot be trusted and is dropped. (V11)
  const brokenClosers = matchAll(body, /<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}>/giu).map((m) => m.start)

  for (const p of matchAll(body, re)) {
    const key = p.groups[0]?.trim()
    if (!key) continue
    const value = p.groups[2] ?? ""
    if (dropRunaway && /[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*parameter\b/iu.test(value)) continue
    if (dropRunaway && brokenClosers.some((start) => start >= p.start && start <= p.end)) continue
    args[key] = decodeValue(value.replace(/<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}>$/iu, ""), p.groups[1])
  }
  return args
}

/**
 * `string="false"` means JSON; anything else (including absent) means a raw string.
 * Only the newline that hugs each tag is removed — the value itself (heredocs,
 * indentation, trailing spaces) is preserved verbatim. (V23, V24)
 */
function decodeValue(raw: string, stringAttr: string | undefined): unknown {
  const trimmedHug = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
  if (stringAttr !== "false") return decodeEntities(trimmedHug)
  try {
    return JSON.parse(trimmedHug.trim())
  } catch {
    return decodeEntities(trimmedHug)
  }
}

/** Decode the HTML entities gateways introduce when re-serialising values. (V22) */
function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
}

interface Match extends Range {
  groups: (string | undefined)[]
}

function matchAll(text: string, re: RegExp): Match[] {
  const matches: Match[] = []
  for (const match of text.matchAll(re)) {
    if (match.index === undefined || match[0].length === 0) continue
    matches.push({ start: match.index, end: match.index + match[0].length, groups: match.slice(1) })
  }
  return matches
}

function firstMatch(text: string, re: RegExp, from: number): Match | undefined {
  return matchAll(text.slice(from), re).map((m) => offset(m, from))[0]
}

function lastMatch(text: string, re: RegExp, from: number): Match | undefined {
  const matches = matchAll(text.slice(from), re)
  return matches.length > 0 ? offset(matches[matches.length - 1]!, from) : undefined
}

function offset(match: Match, by: number): Match {
  return { start: match.start + by, end: match.end + by, groups: match.groups }
}

/** Sort, drop ranges contained in earlier ones, and coalesce overlaps. */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Range[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/** An odd number of fences before `index` means we are inside a code block. (V20) */
function insideCodeFence(text: string, index: number): boolean {
  const fences = text.slice(0, index).match(/```/g)
  return fences !== null && fences.length % 2 === 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
