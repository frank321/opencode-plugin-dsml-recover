/**
 * Streaming DSML recovery as an AI SDK `LanguageModelV3Middleware`.
 *
 * This is the strategy-B seam: OpenCode installs it via `ctx.aisdk.hook("language")`
 * and wraps the provider model with `wrapLanguageModel`. Everything downstream of
 * this middleware is OpenCode's own AI-SDK lowering (`packages/core/src/aisdk.ts`),
 * which already converts `tool-input-*` / `tool-call` / `finish` parts into real tool
 * execution. We therefore only have to speak the AI SDK part vocabulary — see
 * `docs/PATTERNS.md` §4 and `docs/TEST-MATRIX.md` for the cases.
 *
 * Design (ported from CherryStudio #14747, with pi-dsml + openclaw grammar):
 * - Only `text-delta` is buffered; reasoning, tool, and metadata parts pass through.
 * - A 64 KiB swallow cap prevents unbounded buffering if a block never closes.
 * - Unclosed / unparseable blocks are re-emitted as text and `finish` stays `stop`.
 * - Recovered calls rewrite `finishReason.unified` from `stop` to `tool-calls`.
 */

import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { parseDsml, redactionNote, stripRangesWithNote, type DsmlToolCall, type ParseOptions } from "./parse.ts"
import { captureDelta, captureDrain, captureEmit, type DrainDecision } from "./debug-capture.ts"
import { collapseLoop, detectLoop } from "./loopguard.ts"

export interface DsmlMiddlewareOptions extends ParseOptions {
  /** Streaming swallow cap in bytes. Default 65536. */
  readonly bufferLimit?: number
  /** Enable streaming recovery. Default true. */
  readonly stream?: boolean
  /** Enable non-streaming generate recovery. Default true. */
  readonly generate?: boolean
  /**
   * Suppress degenerate repetition loops (the `"Let me do it"` failure). When a
   * resolved text block is flagged by `detectLoop`, the repeated tail is
   * collapsed to a short marker. Off by default: this is a second, independent
   * behaviour and must be opted into explicitly.
   */
  readonly loopGuard?: boolean
  /** Called once when the stream ends, with the per-turn outcome. */
  readonly onSettled?: (stats: DsmlStats) => void
  /** LOCAL FORK: write capture records to /tmp/opencode/dsml-capture.log. */
  readonly capture?: boolean
}

/** Per-turn outcome for logging: what the middleware actually did. */
export interface DsmlStats {
  /** Tool calls recovered from leaked markup. */
  readonly calls: number
  /** Whether any DSML candidate was ever held (false = pure passthrough). */
  readonly sawCandidate: boolean
  /**
   * Whether this turn REDACTED markup it could not recover. Needed by the retry
   * safety net: redaction erases the DSML marker from the stored text, so
   * `looksLikeDsml(transcript)` is false afterwards and the nudge would never
   * fire without this signal (§22). Default false.
   */
  readonly redacted?: boolean
  /**
   * Whether this turn was flagged as a degenerate repetition loop. Like
   * `redacted`, this is a wake signal: a loop that stalls the turn may carry no
   * DSML marker at all, so the retry safety net has nothing else to key on.
   * Default false.
   */
  readonly looping?: boolean
}

const DEFAULT_BUFFER_LIMIT = 64 * 1024

/**
 * Trailing suffix of `buffer` (after its last `<`) that could still grow into a
 * tag opener. A tag split across deltas (`<`, `<BAR`, `<parameter name="sh`, …)
 * must be held back, not emitted as text, until the next chunk arrives. Only the
 * text after the LAST `<` is considered, it must contain no `>`, and it must
 * match the opener-prefix grammar. (V17)
 */
function partialOpenerSuffix(buffer: string): number {
  const lt = buffer.lastIndexOf("<")
  if (lt === -1) return 0
  const tail = buffer.slice(lt)
  if (tail.length > 64 || tail.includes(">")) return 0
  if (!TAG_PREFIX.test(tail)) return 0
  return tail.length
}

/** A `<`-led prefix that may still become a DSML/wrapped open or close tag. */
const TAG_PREFIX =
  /^(?:<)\/?[\uFF5C|]{0,2}\s*(?:D?S?M?L?[\uFF5C|]{0,2}\s*)?(?:p?a?r?a?m?e?t?e?r?|i?n?v?o?k?e?|t?o?o?l?_?c?a?l?l?s?|f?u?n?c?t?i?o?n?_?c?a?l?l?s?|c?a?l?l?s?)?(?:\s*n?a?m?e?\s*=?\s*["']?[^<>"']*)?\s*$/iu

let toolCallSequence = 0

/**
 * Unique tool-call id across parallel streams and sessions. A per-stream index
 * alone could collide when two streams recover a call in the same millisecond,
 * so the id combines time, a process-wide sequence, and randomness.
 */
function toolCallId(index: number): string {
  const seq = toolCallSequence++
  const rand = Math.random().toString(36).slice(2, 8)
  return `dsml_${Date.now().toString(36)}_${seq}_${index}_${rand}`
}

/** Best-effort id for parts that carry one (used only for fallback attribution). */
function textIdOf(chunk: LanguageModelV3StreamPart): string | undefined {
  return typeof (chunk as { id?: unknown }).id === "string" ? (chunk as { id: string }).id : undefined
}

/**
 * Buffering policy (streaming): hold text ONLY from the first byte that could
 * open a tool call. Everything before it is emitted immediately, every chunk.
 * Candidates, in order:
 * 1. A DSML-marked opener (`<BAR DSML …`).
 * 2. A wrapped-tool candidate: `<parameter name="X">` with or without a marker —
 *    the outer shell of the dominant real-world degradation (V26). Plain prose
 *    almost never contains this shape, and the eager-stop below bounds the hold.
 */
const WRAPPED_CANDIDATE = /<(?:[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*)?parameter\s+name\s*=\s*["']?[^\s>"']+/iu
const DSML_OPENER = /<[\uFF5C|]{1,2}\s*DSML/iu

/** Earliest index in `buffer` that could open a call, or -1 when there is none. */
function holdStart(buffer: string): number {
  let earliest = -1
  for (const re of [DSML_OPENER, WRAPPED_CANDIDATE]) {
    re.lastIndex = 0
    const found = re.exec(buffer)
    if (found && (earliest === -1 || found.index < earliest)) earliest = found.index
  }
  return earliest
}

/**
 * Eager-stop window: when holding a candidate that has not yet produced a
 * complete parameter-open (i.e. we are not inside a value), give up after this
 * many held chars and flush as text. Prevents holding prose that merely looked
 * like an opener. Once a complete parameter is open, only the 64 KiB cap bounds
 * the hold, because values can be arbitrarily long.
 */
const EAGER_WINDOW = 1024

/**
 * Loop-guard deferred window (chars). Plain text on the no-candidate path is
 * held until it reaches this size before an emit decision, so `detectLoop` has
 * enough context to tell filler from prose. Tuned just above `detectLoop`'s
 * MIN_LENGTH plus a few deltas; only in effect when `loopGuard` is enabled.
 */
const LOOP_WINDOW = 1024

/** A complete parameter open tag exists in the held text: we may be inside a value. */
const PARAM_OPEN = /<[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*parameter\s+name\s*=/iu

/**
 * Recover tool calls from one complete text buffer. Returns the calls and the text
 * with their ranges removed. Reuses the exact same parser as the repair path.
 */
export function recoverFromText(
  text: string,
  options?: ParseOptions,
): { calls: Array<{ name: string; arguments: Record<string, unknown> }>; text: string } {
  const { calls, ranges } = parseDsml(text, options)
  if (calls.length === 0 && ranges.length === 0) return { calls: [], text }
  let cleaned = ""
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) cleaned += text.slice(cursor, range.start)
    cursor = Math.max(cursor, range.end)
  }
  cleaned += text.slice(cursor)
  return { calls, text: cleaned }
}

export function createDsmlStreamMiddleware(input?: DsmlMiddlewareOptions): LanguageModelV3Middleware {
  const bufferLimit = input?.bufferLimit ?? DEFAULT_BUFFER_LIMIT
  const captureOn = input?.capture ?? false
  const loopGuardOn = input?.loopGuard ?? false
  const parseOptions: ParseOptions = {
    orphanInvoke: input?.orphanInvoke,
    looseParameters: input?.looseParameters,
    rawJsonBody: input?.rawJsonBody,
    wrappedTool: input?.wrappedTool,
    bareValueTool: input?.bareValueTool,
    resolveBareValueKey: input?.resolveBareValueKey,
  }
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream()

      let textBuffer = ""
      let activeTextId: string | null = null
      let recovered = false
      let recoveredInBlock = false
      let sawCandidate = false
      let redacted = false
      let looping = false
      let settled = false
      let counter = 0

      /**
       * Build a capture decision from the current buffer state. `start` and
       * `final` are passed in because they are already computed at each branch;
       * everything else is re-derived here, so this helper can never change
       * behaviour (it only reads).
       */
      const decision = (
        branch: DrainDecision["branch"],
        closed: boolean,
        hasBlockOpen: boolean,
        insideValue: boolean,
        final: boolean,
        start: number,
      ): DrainDecision => ({
        len: textBuffer.length,
        cap: bufferLimit,
        holdStart: start,
        closed,
        hasBlockOpen,
        insideValue,
        overCap: textBuffer.length > bufferLimit,
        overEager: textBuffer.length > EAGER_WINDOW,
        branch,
        final,
      })

      const settle = () => {
        if (settled) return
        settled = true
        input?.onSettled?.({ calls: counter, sawCandidate, redacted, looping })
      }

      const enqueueCall = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>, call: DsmlToolCall) => {
        const id = toolCallId(counter++)
        const input = JSON.stringify(call.arguments)
        controller.enqueue({ type: "tool-input-start", id, toolName: call.name })
        controller.enqueue({ type: "tool-input-delta", id, delta: input })
        controller.enqueue({ type: "tool-input-end", id })
        controller.enqueue({ type: "tool-call", toolCallId: id, toolName: call.name, input })
        recovered = true
        recoveredInBlock = true
      }

      /** True when `text` is only dangling markup/closers and whitespace. */
      const isMarkupNoise = (text: string): boolean => {
        const stripped = text
          .replace(/<\/?[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls|invoke|parameter)(?:\s+[^>\n]*)?>?/giu, "")
          // Leading fragment of a closer split across chunks (`｜ calls>`).
          .replace(/^[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls|invoke|parameter)\s*>?/iu, "")
          .replace(/\s+/g, "")
        return stripped.length === 0 && text.length > 0
      }

      /**
       * Decide what to do with the current buffer.
       *
       * Buffering policy: hold text ONLY from the first byte that could open a
       * tool call (a DSML opener, a partial opener suffix, or a wrapped-tool
       * candidate). Everything before it is emitted immediately. A held
       * candidate that never develops call structure hits the eager-stop window
       * and is flushed as text. `final` resolves whatever remains — recovering
       * complete calls, emitting the rest verbatim, so the buffer always ends
       * empty and no text is ever lost.
       */
      const drain = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>, textId: string, final: boolean) => {
        if (!textBuffer) return

        const start = holdStart(textBuffer)
        if (start === -1) {
          // No candidate: hold back only a suffix that could still grow into an
          // opener. Everything before it is safe to emit.
          const keep = final ? 0 : partialOpenerSuffix(textBuffer)
          if (keep > 0) {
            sawCandidate = true
            captureDrain(captureOn, "aisdk", decision("partial-opener-hold", false, false, false, final, start), textBuffer)
            const emit = textBuffer.slice(0, textBuffer.length - keep)
            textBuffer = textBuffer.slice(textBuffer.length - keep)
            if (emit.length > 0) controller.enqueue({ type: "text-delta", id: textId, delta: emit })
            return
          }
          // Trailing markup noise after an already-recovered call (a mismatched
          // `</invoke>` / `</calls>` that arrived in a later chunk) is dropped
          // rather than leaked: it is pure closers, never prose.
          if (recoveredInBlock && isMarkupNoise(textBuffer)) {
            captureDrain(captureOn, "aisdk", decision("markup-noise-drop", false, false, false, final, start), textBuffer)
            textBuffer = ""
            return
          }
          captureDrain(captureOn, "aisdk", decision("emit-plain", false, false, false, final, start), textBuffer)
          // Second failure mode (loopguard): the model collapses into repeating
          // one sentence ("Let me do it"), carries no markup, and streams out as
          // many small deltas. To classify it we cannot emit each delta eagerly —
          // hold plain text in a bounded window, then flush once we can tell it
          // is (or is not) degenerate. Normal prose is emitted on the next delta
          // past the window or at finality, so the added latency is bounded.
          if (loopGuardOn && !final && textBuffer.length < LOOP_WINDOW) {
            return
          }
          const drainLoop = loopGuardOn ? detectLoop(textBuffer) : undefined
          if (drainLoop?.looping) {
            looping = true
            captureEmit(captureOn, "aisdk", "loop-collapsed", collapseLoop(textBuffer, drainLoop), {
              final,
              reason: drainLoop.reason,
              repeats: drainLoop.repeats,
              uniqueRatio: drainLoop.uniqueRatio,
              originalLen: textBuffer.length,
            })
            controller.enqueue({ type: "text-delta", id: textId, delta: collapseLoop(textBuffer, drainLoop) })
            textBuffer = ""
            return
          }
          controller.enqueue({ type: "text-delta", id: textId, delta: textBuffer })
          textBuffer = ""
          return
        }

        // Emit the safe head; hold from the candidate on.
        if (start > 0) {
          controller.enqueue({ type: "text-delta", id: textId, delta: textBuffer.slice(0, start) })
          textBuffer = textBuffer.slice(start)
        }
        sawCandidate = true

        // A complete, closed block is resolvable now. Wrapped-tool shapes end in
        // a mismatched `</invoke>` / `</calls>` rather than a block closer —
        // those count as completion ONLY when no block opener is pending
        // (otherwise the trailing block closer would arrive later and leak).
        const hasBlockOpen =
          /<[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls)\s*>/iu.test(
            textBuffer,
          )
        const closed =
          /<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls)\s*>/iu.test(
            textBuffer,
          ) ||
          (!hasBlockOpen &&
            /<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:invoke|calls)\s*>/iu.test(textBuffer))
        const overCap = textBuffer.length > bufferLimit
        if (!final && closed) {
          captureDrain(captureOn, "aisdk", decision("resolved-closed", closed, hasBlockOpen, false, final, start), textBuffer)
          emitResolved(controller, textId, false)
          return
        }
        // Eager stop: a candidate that is not developing call structure (no
        // complete parameter open yet, so we are not inside a long value) and has
        // grown past the window is prose — flush it and resume scanning fresh.
        //
        // Fork guard: NOT while a real block opener is pending (`hasBlockOpen`).
        // A live `<…tool_calls>`/`<…function_calls>` opener means this is a
        // genuine envelope whose `parameter` opener may have been dropped by the
        // provider's mangling (the ~300k long-context shape). Eager-flushing it
        // here emitted the raw markup verbatim at ~1 KB, pre-empting the 64 KiB
        // over-cap redaction on the very next branch. Hold to the cap instead so
        // the runt gets redacted (or recovered once its closer arrives).
        // Pure prose that only *resembles* an opener (no block opener) still
        // eager-flushes as before.
        PARAM_OPEN.lastIndex = 0
        const insideValue = PARAM_OPEN.test(textBuffer)
        if (!final && !overCap && !insideValue && !hasBlockOpen && textBuffer.length > EAGER_WINDOW) {
          captureDrain(captureOn, "aisdk", decision("eager-flush", closed, hasBlockOpen, insideValue, final, start), textBuffer)
          controller.enqueue({ type: "text-delta", id: textId, delta: textBuffer })
          textBuffer = ""
          return
        }
        // Nothing complete yet and we are still streaming: hold, until the cap.
        if (!final && !overCap) {
          captureDrain(captureOn, "aisdk", decision("hold-continue", closed, hasBlockOpen, insideValue, final, start), textBuffer)
          return
        }
        // Final, over-cap, or unresolved at end: emit everything (recovering any
        // complete calls that do exist, but never swallowing an unclosed tail).
        if (overCap && !closed) {
          captureDrain(captureOn, "aisdk", decision("overcap-flush", closed, hasBlockOpen, insideValue, final, start), textBuffer)
          // Fork (openclaw lesson): a held DSML candidate that blew the cap and
          // never closed is a runt — redact it rather than emitting raw markup.
          // The old verbatim flush is a primary way DSML tags reach the chat.
          const { ranges: overRanges } = parseDsml(textBuffer, parseOptions)
          const redactedText = overRanges.length > 0 ? stripRangesWithNote(textBuffer, overRanges, redactionNote([])) : textBuffer
          if (overRanges.length > 0) redacted = true
          captureEmit(captureOn, "aisdk", "over-cap-flush", redactedText, { cap: bufferLimit, len: textBuffer.length, ranges: overRanges.length })
          if (redactedText.length > 0) controller.enqueue({ type: "text-delta", id: textId, delta: redactedText })
          textBuffer = ""
          return
        }
        captureDrain(captureOn, "aisdk", decision("resolved-final", closed, hasBlockOpen, insideValue, final, start), textBuffer)
        emitResolved(controller, textId, true)
      }

      const emitResolved = (controller: TransformStreamDefaultController<LanguageModelV3StreamPart>, textId: string, isFinal: boolean) => {
        const original = textBuffer
        const { calls, text } = recoverFromText(textBuffer, parseOptions)
        // Ranges parseDsml asked us to remove. Present even when no call was
        // recovered (an unclosed/corrupt block strips to end-of-text, V15).
        const { ranges } = parseDsml(original, parseOptions)
        textBuffer = ""
        // Recovery rule: strip only when we recovered a call OR the buffer is
        // recognisably DSML *markup* with nothing to recover. The second clause
        // is the openclaw lesson (fork): an unclosed/runt block must be DROPPED,
        // not re-emitted — re-emitting is what leaks raw tags into the chat at
        // long context. Genuine prose never carries `ranges`, so it is untouched.
        if (calls.length === 0) {
          if (ranges.length > 0) {
            const redactedText = stripRangesWithNote(original, ranges, redactionNote([]))
            redacted = true
            captureEmit(captureOn, "aisdk", "emit-resolved-unresolved-redacted", redactedText, {
              final: isFinal,
              recoveredCalls: 0,
              ranges: ranges.length,
              cap: bufferLimit,
            })
            if (redactedText.length > 0) controller.enqueue({ type: "text-delta", id: textId, delta: redactedText })
            return
          }
          captureEmit(captureOn, "aisdk", "emit-resolved-no-call", original, {
            final: isFinal,
            recoveredCalls: 0,
            cap: bufferLimit,
          })
          // Second failure mode (loopguard): plain prose with no markup at all,
          // but degenerate. Collapse before it reaches the transcript; the
          // unmodified text is never used here once the guard fires.
          const loop = loopGuardOn ? detectLoop(original) : undefined
          if (loop?.looping) {
            looping = true
            captureEmit(captureOn, "aisdk", "loop-collapsed", collapseLoop(original, loop), {
              final: isFinal,
              reason: loop.reason,
              repeats: loop.repeats,
              uniqueRatio: loop.uniqueRatio,
              originalLen: original.length,
            })
            controller.enqueue({ type: "text-delta", id: textId, delta: collapseLoop(original, loop) })
            return
          }
          controller.enqueue({ type: "text-delta", id: textId, delta: original })
          return
        }
        // The buffer can end mid-tag (a trailing closer already streaming in when
        // resolution fired). Hold the partial back while the stream continues;
        // at finality it ships verbatim (never swallow).
        let cleaned = text
        if (!isFinal) {
          const holdBack = partialOpenerSuffix(cleaned)
          if (holdBack > 0) {
            textBuffer = cleaned.slice(cleaned.length - holdBack)
            cleaned = cleaned.slice(0, cleaned.length - holdBack)
          }
        }
        captureEmit(captureOn, "aisdk", "emit-resolved", cleaned, {
          final: isFinal,
          recoveredCalls: calls.length,
          names: calls.map((c) => c.name),
          originalLen: original.length,
        })
        if (cleaned.length > 0) controller.enqueue({ type: "text-delta", id: textId, delta: cleaned })
        for (const call of calls) enqueueCall(controller, call)
      }

      return {
        stream: stream.pipeThrough(
          new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
            transform(chunk, controller) {
              if (chunk.type === "text-start") {
                activeTextId = chunk.id
                recoveredInBlock = false
                controller.enqueue(chunk)
                return
              }
              if (chunk.type === "text-end") {
                drain(controller, chunk.id, true)
                controller.enqueue(chunk)
                activeTextId = null
                return
              }
              if (chunk.type === "finish") {
                drain(controller, activeTextId ?? "dsml-fallback", true)
                const rewritten =
                  recovered && chunk.finishReason.unified === "stop"
                    ? { ...chunk, finishReason: { ...chunk.finishReason, unified: "tool-calls" as const } }
                    : chunk
                controller.enqueue(rewritten)
                return
              }
              if (chunk.type !== "text-delta") {
                // Transition: the stream is moving to reasoning, a native tool
                // part, or another block. Flush held text FIRST so transcript
                // order is preserved — buffered text must never leak out after
                // the parts that follow it.
                if (textBuffer) drain(controller, activeTextId ?? textIdOf(chunk) ?? "dsml-fallback", true)
                controller.enqueue(chunk)
                return
              }

              const id = chunk.id
              if (activeTextId === null) activeTextId = id
              textBuffer += chunk.delta
              captureDelta(captureOn, "aisdk", textBuffer.length, chunk.delta.length, bufferLimit)
              drain(controller, id, false)
            },
            flush(controller) {
              drain(controller, activeTextId ?? "dsml-fallback", true)
              settle()
            },
          }),
        ),
        ...rest,
      }
    },
  }
}

/**
 * Recover DSML calls from a non-streaming generate result. Text parts are split:
 * prose stays text, each recovered call becomes a `tool-call` content part. The
 * finish reason flips to `tool-calls` when at least one call was recovered.
 */
export function recoverGenerateResult(
  content: ReadonlyArray<LanguageModelV3Content>,
  finishReason: { unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"; raw: string | undefined },
  options?: ParseOptions,
): { content: LanguageModelV3Content[]; finishReason: typeof finishReason; recovered: number } {
  const next: LanguageModelV3Content[] = []
  let recovered = 0
  let counter = 0
  for (const part of content) {
    if (part.type !== "text") {
      next.push(part)
      continue
    }
    const { calls, ranges } = parseDsml(part.text, options)
    if (calls.length === 0 && ranges.length === 0) {
      next.push(part)
      continue
    }
    let cursor = 0
    let kept = ""
    for (const range of ranges) {
      if (range.start > cursor) kept += part.text.slice(cursor, range.start)
      cursor = Math.max(cursor, range.end)
    }
    kept += part.text.slice(cursor)
    // Streaming rule applies here too: no recovered call means the text goes back
    // untouched rather than stripped.
    if (calls.length === 0) {
      next.push(part)
      continue
    }
    if (kept.length > 0) next.push({ ...part, text: kept })
    for (const call of calls) {
      recovered++
      next.push({
        type: "tool-call",
        toolCallId: toolCallId(counter++),
        toolName: call.name,
        input: JSON.stringify(call.arguments),
      })
    }
  }
  if (recovered === 0) return { content: [...content], finishReason, recovered }
  return {
    content: next,
    finishReason: finishReason.unified === "stop" ? { ...finishReason, unified: "tool-calls" } : finishReason,
    recovered,
  }
}

/**
 * Wrap a `LanguageModelV3` so every `doStream`/`doGenerate` passes through DSML
 * recovery. This is a dependency-free alternative to `wrapLanguageModel` from the
 * `ai` package: the returned object implements the same `LanguageModelV3` surface,
 * so OpenCode's AI-SDK lowering consumes it unchanged.
 */
export function wrapDsmlLanguageModel(model: LanguageModelV3, input?: DsmlMiddlewareOptions): LanguageModelV3 {
  const streamEnabled = input?.stream ?? true
  const generateEnabled = input?.generate ?? true
  if (!streamEnabled && !generateEnabled) return model
  const middleware = createDsmlStreamMiddleware(input)
  const parseOptions: ParseOptions = {
    orphanInvoke: input?.orphanInvoke,
    looseParameters: input?.looseParameters,
    rawJsonBody: input?.rawJsonBody,
    wrappedTool: input?.wrappedTool,
    bareValueTool: input?.bareValueTool,
    resolveBareValueKey: input?.resolveBareValueKey,
  }
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const result = await model.doGenerate(options)
      if (!generateEnabled) return result
      const recovered = recoverGenerateResult(result.content, result.finishReason, parseOptions)
      input?.onSettled?.({ calls: recovered.recovered, sawCandidate: recovered.recovered > 0 })
      if (recovered.recovered === 0) return result
      return { ...result, content: recovered.content, finishReason: recovered.finishReason }
    },
    async doStream(options) {
      if (!streamEnabled) return model.doStream(options)
      const wrapped = await middleware.wrapStream!({
        doStream: () => model.doStream(options),
        doGenerate: () => model.doGenerate(options),
        params: options,
        model,
      })
      return wrapped
    },
  }
}
