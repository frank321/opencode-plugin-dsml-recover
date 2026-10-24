/**
 * Strategy B for the native protocol path: rewrite the provider's OpenAI-Chat
 * SSE stream inside `session.hook("http.response")`.
 *
 * Why this seam exists: catalog providers such as `opencode-go` resolve to the
 * NATIVE `@opencode/ai/providers/openai-compatible` route (see
 * `AISDKNative.native`), so `ctx.aisdk.hook("language")` never fires for them.
 * The native route, however, offers every request to the `http.request` /
 * `http.response` hooks (`packages/core/src/session/model-request.ts`), which see
 * the raw SSE bytes. This module parses those bytes, runs the same DSML state
 * machine as `src/middleware.ts` over the `content` deltas, and re-emits a
 * corrected stream: text without DSML spans, synthetic `tool_calls` deltas for
 * each recovered call, and a terminal `finish_reason` rewritten from `stop` to
 * `tool_calls`. The native `openai-chat` parser accepts exactly this shape
 * (`delta.tool_calls[]` indexed by `index`, arguments accumulated across deltas).
 *
 * Streaming is preserved: chunks without a DSML candidate pass through
 * immediately; only candidate spans are held, under the same eager-stop and cap
 * policy as the AI-SDK middleware.
 */

import { parseDsml, redactionNote, stripRangesWithNote, type DsmlToolCall, type ParseOptions } from "./parse.ts"
import { captureDelta, captureDrain, captureEmit, type DrainDecision } from "./debug-capture.ts"
import { collapseLoop, detectLoop } from "./loopguard.ts"

export interface SseRewriterOptions extends ParseOptions {
  /** Streaming swallow cap in bytes. Default 65536. */
  readonly bufferLimit?: number
  /** Suppress degenerate repetition loops (the `"Let me do it"` failure). Default false. */
  readonly loopGuard?: boolean
  /** Called once when the stream closes, with the per-turn outcome. */
  readonly onSettled?: (stats: SseStats) => void
  /** LOCAL FORK: write capture records to /tmp/opencode/dsml-capture.log. */
  readonly capture?: boolean
}

/** Per-turn outcome for logging: what the rewrite actually did. */
export interface SseStats {
  /** Tool calls recovered from leaked markup. */
  readonly calls: number
  /** Whether any DSML candidate was ever held (false = pure passthrough). */
  readonly sawCandidate: boolean
  /**
   * Whether this turn REDACTED leaked markup it could not recover. The retry
   * safety net needs this: redaction erases the DSML marker from the stored
   * text, so `looksLikeDsml(transcript)` is false afterwards and the nudge
   * would never fire. Recording it here restores the wake for exactly the case
   * the live fix failed to recover (§22). Default false.
   */
  readonly redacted?: boolean
  /**
   * Whether this turn was flagged as a degenerate repetition loop. A wake
   * signal like `redacted`: the loop may carry no DSML marker, so the retry
   * safety net has nothing else to key on. Default false.
   */
  readonly looping?: boolean
}

const DEFAULT_BUFFER_LIMIT = 64 * 1024
const EAGER_WINDOW = 1024
/** Loop-guard deferred window (chars); see middleware.ts for rationale. */
const LOOP_WINDOW = 1024

const WRAPPED_CANDIDATE = /<(?:[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*)?parameter\s+name\s*=\s*["']?[^\s>"']+/iu
const DSML_OPENER = /<[\uFF5C|]{1,2}\s*DSML/iu
const PARAM_OPEN = /<[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*parameter\s+name\s*=/iu

function holdStart(buffer: string): number {
  let earliest = -1
  for (const re of [DSML_OPENER, WRAPPED_CANDIDATE]) {
    re.lastIndex = 0
    const found = re.exec(buffer)
    if (found && (earliest === -1 || found.index < earliest)) earliest = found.index
  }
  return earliest
}

const TAG_PREFIX =
  /^(?:<)\/?[\uFF5C|]{0,2}\s*(?:D?S?M?L?[\uFF5C|]{0,2}\s*)?(?:p?a?r?a?m?e?t?e?r?|i?n?v?o?k?e?|t?o?o?l?_?c?a?l?l?s?|f?u?n?c?t?i?o?n?_?c?a?l?l?s?|c?a?l?l?s?)?(?:\s*n?a?m?e?\s*=?\s*["']?[^<>"']*)?\s*$/iu

function partialOpenerSuffix(buffer: string): number {
  const lt = buffer.lastIndexOf("<")
  if (lt === -1) return 0
  const tail = buffer.slice(lt)
  if (tail.length > 64 || tail.includes(">")) return 0
  if (!TAG_PREFIX.test(tail)) return 0
  return tail.length
}

export interface SseFrame {
  readonly data: string
}

/** Split raw SSE bytes into complete `data:` payloads, keeping a text remainder. */
export function splitSseFrames(text: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  const parts = text.split("\n\n")
  const rest = parts.pop() ?? ""
  for (const part of parts) {
    const lines = part.split("\n").filter((line) => line.startsWith("data:"))
    if (lines.length === 0) continue
    frames.push(lines.map((line) => line.slice(5).trimStart()).join("\n"))
  }
  return { frames, rest }
}

export function sseFrame(payload: string): string {
  return `data: ${payload}\n\n`
}

interface ToolDelta {
  readonly index: number
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

function contentOf(event: Record<string, unknown>): string | undefined {
  const choices = event["choices"]
  if (!Array.isArray(choices)) return undefined
  const delta = (choices[0] as Record<string, unknown> | undefined)?.["delta"] as Record<string, unknown> | undefined
  const content = delta?.["content"]
  return typeof content === "string" ? content : undefined
}

function finishOf(event: Record<string, unknown>): string | undefined {
  const choices = event["choices"]
  if (!Array.isArray(choices)) return undefined
  const reason = (choices[0] as Record<string, unknown> | undefined)?.["finish_reason"]
  return typeof reason === "string" ? reason : undefined
}

function textEvent(text: string): string {
  return sseFrame(JSON.stringify({ choices: [{ delta: { content: text }, index: 0 }] }))
}

let toolCallCounter = 0

function toolCallEvents(call: DsmlToolCall, index: number): string[] {
  const id = `dsml_${Date.now().toString(36)}_${toolCallCounter++}_${Math.random().toString(36).slice(2, 8)}`
  const args = JSON.stringify(call.arguments)
  // Name first, then arguments in small chunks so progressive parsers keep up.
  const out = [
    sseFrame(
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id, function: { name: call.name } }] }, index: 0 }] }),
    ),
  ]
  for (let i = 0; i < args.length; i += 512) {
    out.push(
      sseFrame(
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(i, i + 512) } }] }, index: 0 }],
        }),
      ),
    )
  }
  return out
}

/**
 * Incremental SSE rewriter. Feed raw upstream bytes with `push`; collect
 * rewritten SSE frames from the return value. Call `flush` at stream end.
 * Non-DSML traffic passes straight through, preserving streaming.
 */
export class SseDsmlRewriter {
  private frameRest = ""
  private textBuffer = ""
  private recovered = false
  private recoveredInBlock = false
  private toolIndex = 0
  private maxNativeIndex = -1
  private sawCandidate = false
  private settled = false
  private redacted = false
  private looping = false
  private readonly bufferLimit: number
  private readonly loopGuardOn: boolean
  private readonly parseOptions: ParseOptions
  private readonly onSettled?: (stats: SseStats) => void
  private readonly captureOn: boolean

  constructor(input?: SseRewriterOptions) {
    this.bufferLimit = input?.bufferLimit ?? DEFAULT_BUFFER_LIMIT
    this.loopGuardOn = input?.loopGuard ?? false
    this.onSettled = input?.onSettled
    this.captureOn = input?.capture ?? false
    this.parseOptions = {
      orphanInvoke: input?.orphanInvoke,
      looseParameters: input?.looseParameters,
      rawJsonBody: input?.rawJsonBody,
      wrappedTool: input?.wrappedTool,
      bareValueTool: input?.bareValueTool,
      resolveBareValueKey: input?.resolveBareValueKey,
    }
  }

  get recoveredCalls(): boolean {
    return this.recovered
  }

  /** Report the per-turn outcome exactly once (stream close). */
  settle(): void {
    if (this.settled) return
    this.settled = true
    this.onSettled?.({ calls: this.toolIndex, sawCandidate: this.sawCandidate, redacted: this.redacted, looping: this.looping })
  }

  /** Feed upstream bytes; returns rewritten SSE frames to send downstream. */
  push(bytes: string): string[] {
    const out: string[] = []
    const { frames, rest } = splitSseFrames(this.frameRest + bytes)
    this.frameRest = rest
    for (const payload of frames) {
      if (payload === "[DONE]") {
        out.push(...this.drain(true))
        out.push(sseFrame("[DONE]"))
        continue
      }
      let event: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(payload)
        if (typeof parsed !== "object" || parsed === null) {
          out.push(sseFrame(payload))
          continue
        }
        event = parsed as Record<string, unknown>
      } catch {
        out.push(sseFrame(payload))
        continue
      }
      const content = contentOf(event)
      const finish = finishOf(event)
      // NB: content and finish_reason can arrive in the SAME event. The content
      // is consumed into the text buffer, so the forwarded event must carry it
      // stripped — otherwise the text appears twice downstream. Dropping either
      // side breaks the run ("stream ended without finish_reason" / duplication).
      const choices = Array.isArray(event["choices"]) ? (event["choices"] as unknown[]) : []
      const first = ((choices[0] as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
      // Track native tool-call indexes: synthetic indexes are allocated above
      // every native index observed, because the native parser keys accumulation
      // by `index` (falling back from `id`) — reusing one would merge our
      // arguments into the provider's call.
      const nativeList = (first["delta"] as Record<string, unknown> | undefined)?.["tool_calls"]
      if (Array.isArray(nativeList)) {
        for (const tc of nativeList) {
          const idx = (tc as Record<string, unknown>)?.["index"]
          if (typeof idx === "number" && idx > this.maxNativeIndex) this.maxNativeIndex = idx
        }
      }
      const firstDelta = (first["delta"] as Record<string, unknown>) ?? {}
      const { content: _consumed, ...deltaRest } = firstDelta
      const strippedEvent = { ...event, choices: [{ ...first, delta: deltaRest }] }
      const hasMore = finish !== undefined || Object.keys(deltaRest).length > 0 || choices.length > 1
      if (content !== undefined) {
        this.textBuffer += content
        captureDelta(this.captureOn, "sse", this.textBuffer.length, content.length, this.bufferLimit)
        out.push(...this.drain(false))
      }
      if (finish !== undefined) {
        out.push(...this.drain(true))
        if (this.recovered && finish === "stop") {
          out.push(sseFrame(JSON.stringify({ ...event, choices: [{ ...first, finish_reason: "tool_calls" }] })))
        } else if (hasMore) {
          out.push(sseFrame(JSON.stringify(strippedEvent)))
        } else if (content === undefined) {
          out.push(sseFrame(payload))
        }
        continue
      }
      if (content !== undefined) {
        if (hasMore) out.push(sseFrame(JSON.stringify(strippedEvent)))
        continue
      }
      // Usage chunks, role deltas, errors: forward untouched (order preserved:
      // the text buffer was drained above for content; usage carries no text).
      out.push(sseFrame(payload))
    }
    return out
  }

  /** End of stream: resolve whatever remains. Buffer always ends empty. */
  flush(): string[] {
    const out = this.drain(true)
    if (this.frameRest.trim().length > 0) out.push(sseFrame(this.frameRest.trim()))
    this.frameRest = ""
    this.settle()
    return out
  }

  private emitText(text: string, out: string[]): void {
    if (text.length > 0) out.push(textEvent(text))
  }

  private emitResolved(out: string[], final: boolean): void {
    const original = this.textBuffer
    const { calls, ranges } = parseDsml(this.textBuffer, this.parseOptions)
    this.textBuffer = ""
    if (calls.length === 0) {
      // Fork (openclaw lesson): an unresolved DSML *runt* (ranges present, no
      // recoverable call) must be DROPPED, not echoed — echoing leaks raw tags.
      // Prose never carries ranges, so it passes through unchanged.
      if (ranges.length > 0) {
        const redacted = stripRangesWithNote(original, ranges, redactionNote([]))
        this.redacted = true
        captureEmit(this.captureOn, "sse", "emit-resolved-unresolved-redacted", redacted, {
          final,
          recoveredCalls: 0,
          ranges: ranges.length,
          cap: this.bufferLimit,
        })
        this.emitText(redacted, out)
        return
      }
      captureEmit(this.captureOn, "sse", "emit-resolved-no-call", original, {
        final,
        recoveredCalls: 0,
        cap: this.bufferLimit,
      })
      // Loopguard: plain prose with no markup, but degenerate. Collapse it.
      const loop = this.loopGuardOn ? detectLoop(original) : undefined
      if (loop?.looping) {
        this.looping = true
        const collapsed = collapseLoop(original, loop)
        captureEmit(this.captureOn, "sse", "loop-collapsed", collapsed, {
          final,
          reason: loop.reason,
          repeats: loop.repeats,
          uniqueRatio: loop.uniqueRatio,
          originalLen: original.length,
        })
        this.emitText(collapsed, out)
        return
      }
      this.emitText(original, out)
      return
    }
    let cleaned = ""
    let cursor = 0
    for (const range of ranges) {
      if (range.start > cursor) cleaned += original.slice(cursor, range.start)
      cursor = Math.max(cursor, range.end)
    }
    cleaned += original.slice(cursor)
    // The buffer can end mid-tag (a trailing closer already streaming in when
    // resolution fired). A partial tag is unparseable by definition: hold it
    // back for the next drain while the stream continues; at finality there is
    // nothing left to complete it, so it ships verbatim (never swallow).
    if (!final) {
      const holdBack = partialOpenerSuffix(cleaned)
      if (holdBack > 0) {
        this.textBuffer = cleaned.slice(cleaned.length - holdBack)
        cleaned = cleaned.slice(0, cleaned.length - holdBack)
      }
    }
    this.emitText(cleaned, out)
    captureEmit(this.captureOn, "sse", "emit-resolved", cleaned, {
      final,
      recoveredCalls: calls.length,
      names: calls.map((c) => c.name),
      originalLen: original.length,
    })
    for (const call of calls) {
      // Allocate synthetic indexes above every native index observed so far.
      // The native parser keys accumulation by `index` (falling back from `id`),
      // so reusing a native index would merge our arguments into their call.
      if (this.toolIndex <= this.maxNativeIndex) this.toolIndex = this.maxNativeIndex + 1
      for (const frame of toolCallEvents(call, this.toolIndex++)) out.push(frame)
      this.recovered = true
      this.recoveredInBlock = true
    }
  }

  private isMarkupNoise(text: string): boolean {
    const stripped = text
      .replace(/<\/?[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls|invoke|parameter)(?:\s+[^>\n]*)?>?/giu, "")
      // Leading fragment of a closer split across chunks (`｜ calls>`): the `<`
      // went out with an earlier resolution, leaving only bars + tag name.
      .replace(/^[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls|invoke|parameter)\s*>?/iu, "")
      .replace(/\s+/g, "")
    return stripped.length === 0 && text.length > 0
  }

  /** Build a capture decision from the current buffer (read-only). */
  private decision(
    branch: DrainDecision["branch"],
    closed: boolean,
    hasBlockOpen: boolean,
    insideValue: boolean,
    final: boolean,
    start: number,
  ): DrainDecision {
    return {
      len: this.textBuffer.length,
      cap: this.bufferLimit,
      holdStart: start,
      closed,
      hasBlockOpen,
      insideValue,
      overCap: this.textBuffer.length > this.bufferLimit,
      overEager: this.textBuffer.length > EAGER_WINDOW,
      branch,
      final,
    }
  }

  private drain(final: boolean): string[] {
    const out: string[] = []
    if (!this.textBuffer) return out
    const start = holdStart(this.textBuffer)
    if (start === -1) {
      const keep = final ? 0 : partialOpenerSuffix(this.textBuffer)
      if (keep > 0) {
        this.sawCandidate = true
        captureDrain(this.captureOn, "sse", this.decision("partial-opener-hold", false, false, false, final, start), this.textBuffer)
        const emit = this.textBuffer.slice(0, this.textBuffer.length - keep)
        this.textBuffer = this.textBuffer.slice(this.textBuffer.length - keep)
        this.emitText(emit, out)
        return out
      }
      if (this.recoveredInBlock && this.isMarkupNoise(this.textBuffer)) {
        // NB: recoveredInBlock stays true for the rest of this text block —
        // later closer fragments (`</calls>` split across chunks) must still drop.
        captureDrain(this.captureOn, "sse", this.decision("markup-noise-drop", false, false, false, final, start), this.textBuffer)
        this.textBuffer = ""
        return out
      }
      captureDrain(this.captureOn, "sse", this.decision("emit-plain", false, false, false, final, start), this.textBuffer)
      // Loopguard: hold plain text in a bounded window before the emit
      // decision, so detectLoop has enough context to classify it. Normal
      // prose flushes on the next delta past the window or at finality.
      if (this.loopGuardOn && !final && this.textBuffer.length < LOOP_WINDOW) {
        return out
      }
      const drainLoop = this.loopGuardOn ? detectLoop(this.textBuffer) : undefined
      if (drainLoop?.looping) {
        this.looping = true
        const collapsed = collapseLoop(this.textBuffer, drainLoop)
        captureEmit(this.captureOn, "sse", "loop-collapsed", collapsed, {
          final,
          reason: drainLoop.reason,
          repeats: drainLoop.repeats,
          uniqueRatio: drainLoop.uniqueRatio,
          originalLen: this.textBuffer.length,
        })
        this.emitText(collapsed, out)
        this.textBuffer = ""
        return out
      }
      this.emitText(this.textBuffer, out)
      this.textBuffer = ""
      return out
    }
    if (start > 0) {
      this.emitText(this.textBuffer.slice(0, start), out)
      this.textBuffer = this.textBuffer.slice(start)
    }
    this.sawCandidate = true
    const hasBlockOpen =
      /<[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls)\s*>/iu.test(this.textBuffer)
    const closed =
      /<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:tool_calls|function_calls|tool_call|calls)\s*>/iu.test(this.textBuffer) ||
      (!hasBlockOpen && /<\/[\uFF5C|]{1,2}\s*DSML\s*[\uFF5C|]{1,2}\s*(?:invoke|calls)\s*>/iu.test(this.textBuffer))
    const overCap = this.textBuffer.length > this.bufferLimit
    if (!final && closed) {
      captureDrain(this.captureOn, "sse", this.decision("resolved-closed", closed, hasBlockOpen, false, final, start), this.textBuffer)
      this.emitResolved(out, false)
      return out
    }
    PARAM_OPEN.lastIndex = 0
    const insideValue = PARAM_OPEN.test(this.textBuffer)
    // Fork guard: hold while a real block opener is pending (`hasBlockOpen`),
    // even past the eager window — a mangled long-context envelope may arrive
    // with its `parameter` opener dropped, and eager-flushing emitted the raw
    // markup verbatim at ~1 KB, pre-empting the over-cap redaction below.
    // Prose without a block opener still eager-flushes.
    if (!final && !overCap && !insideValue && !hasBlockOpen && this.textBuffer.length > EAGER_WINDOW) {
      captureDrain(this.captureOn, "sse", this.decision("eager-flush", closed, hasBlockOpen, insideValue, final, start), this.textBuffer)
      this.emitText(this.textBuffer, out)
      this.textBuffer = ""
      return out
    }
    if (!final && !overCap) {
      captureDrain(this.captureOn, "sse", this.decision("hold-continue", closed, hasBlockOpen, insideValue, final, start), this.textBuffer)
      return out
    }
    if (overCap && !closed) {
      captureDrain(this.captureOn, "sse", this.decision("overcap-flush", closed, hasBlockOpen, insideValue, final, start), this.textBuffer)
      // Fork (openclaw lesson): redact an over-cap runt instead of emitting raw
      // markup — the verbatim flush is a primary DSML leak path.
      const { ranges: overRanges } = parseDsml(this.textBuffer, this.parseOptions)
      const redacted = overRanges.length > 0 ? stripRangesWithNote(this.textBuffer, overRanges, redactionNote([])) : this.textBuffer
      if (overRanges.length > 0) this.redacted = true
      captureEmit(this.captureOn, "sse", "over-cap-flush", redacted, { cap: this.bufferLimit, len: this.textBuffer.length, ranges: overRanges.length })
      this.emitText(redacted, out)
      this.textBuffer = ""
      return out
    }
    captureDrain(this.captureOn, "sse", this.decision("resolved-final", closed, hasBlockOpen, insideValue, final, start), this.textBuffer)
    this.emitResolved(out, true)
    return out
  }
}

/**
 * Wrap a provider SSE `Response` with DSML recovery. Non-SSE responses pass
 * through untouched. Consumes the upstream body incrementally — normal traffic
 * keeps streaming; only candidate spans are held. Synchronous: the returned
 * Response pumps lazily, so it can be assigned directly in the hook.
 */
export function rewriteSseResponse(response: Response, options?: SseRewriterOptions): Response {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream") || !response.body) return response
  const rewriter = new SseDsmlRewriter(options)
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const frames = rewriter.push(decoder.decode(value, { stream: true }))
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame))
        }
        for (const frame of rewriter.flush()) controller.enqueue(new TextEncoder().encode(frame))
        controller.close()
      } catch (error) {
        rewriter.settle()
        controller.error(error)
      }
    },
  })
  return new Response(stream, { status: response.status, headers: response.headers })
}
