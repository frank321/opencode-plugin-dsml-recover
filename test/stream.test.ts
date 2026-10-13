/**
 * Streaming middleware tests. One `test(...)` per row in docs/TEST-MATRIX.md under
 * "Streaming". We drive the middleware the same way `wrapLanguageModel` does, and
 * assert on the emitted AI-SDK parts — the exact contract OpenCode's lowering reads.
 */

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"
import { createDsmlStreamMiddleware } from "../src/middleware.ts"
import { BAR, block, closeTag, invoke, marker, param, tag, text } from "./fixtures.ts"

function source(deltas: string[], finish: "stop" | "tool-calls" = "stop") {
  const parts: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...deltas.map((delta): LanguageModelV3StreamPart => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: finish, raw: finish }, usage: {} as never },
  ]
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function run(deltas: string[], finish: "stop" | "tool-calls" = "stop") {
  const middleware = createDsmlStreamMiddleware()
  const wrapped = await middleware.wrapStream!({
    doStream: async () => ({ stream: source(deltas, finish) }),
    doGenerate: (async () => ({})) as never,
    params: {} as never,
    model: {} as never,
  })
  const events: LanguageModelV3StreamPart[] = []
  const reader = wrapped.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(value)
  }
  return events
}

const streamedText = (events: LanguageModelV3StreamPart[]) =>
  events.filter((e): e is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> => e.type === "text-delta").map((e) => e.delta).join("")
const toolCalls = (events: LanguageModelV3StreamPart[]) =>
  events.filter((e): e is Extract<LanguageModelV3StreamPart, { type: "tool-call" }> => e.type === "tool-call")
const finishOf = (events: LanguageModelV3StreamPart[]) =>
  events.find((e): e is Extract<LanguageModelV3StreamPart, { type: "finish" }> => e.type === "finish")!
const lifecycle = (events: LanguageModelV3StreamPart[]) =>
  events.filter((e) => e.type === "tool-input-start" || e.type === "tool-input-delta" || e.type === "tool-input-end").map((e) => e.type)

describe("streaming middleware", () => {
  test("stream-text-passthrough", async () => {
    const events = await run(["Hello, ", "world!"])
    expect(streamedText(events)).toBe("Hello, world!")
    expect(toolCalls(events)).toHaveLength(0)
    expect(finishOf(events).finishReason.unified).toBe("stop")
  })

  test("stream-v2-recovered (doubled bars, chunked per token)", async () => {
    // The captured CherryStudio SSE shape: every marker character split.
    const doubles = marker(BAR, 2)
    const deltas = [
      "<",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      "tool",
      "_c",
      "alls",
      ">",
      "<",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      'invoke name="bash">',
      "<",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      'parameter name="command" string="true">ls -la',
      "</",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      "parameter>",
      "</",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      "invoke>",
      "</",
      `${BAR}${BAR}`,
      "DS",
      "ML",
      `${BAR}${BAR}`,
      "tool_calls>",
    ]
    expect(doubles).toContain("DSML")
    const events = await run(deltas)
    const calls = toolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe("bash")
    expect(JSON.parse(calls[0]!.input)).toEqual({ command: "ls -la" })
    expect(streamedText(events)).toBe("")
    expect(streamedText(events)).not.toContain("DSML")
  })

  test("stream-finish-rewrite", async () => {
    const events = await run([block([invoke("bash", [param("command", "pwd")])])])
    expect(finishOf(events).finishReason.unified).toBe("tool-calls")
  })

  test("stream-finish-untouched", async () => {
    const events = await run(["no tools here"])
    expect(finishOf(events).finishReason.unified).toBe("stop")
  })

  test("stream-unclosed-outer-but-complete-invoke is recovered (V9/V15)", async () => {
    // Outer block never closes, but the inner invoke is complete. Recovering the
    // unambiguous call beats dropping it — this matches the DB degradation.
    const deltas = [tag("tool_calls"), invoke("bash", [param("command", "pwd")])]
    const events = await run(deltas)
    expect(toolCalls(events)).toHaveLength(1)
    expect(toolCalls(events)[0]!.toolName).toBe("bash")
  })

  test("stream-truncated-invoke is redacted, not leaked (fork)", async () => {
    // Opener plus an invoke that never closes: nothing usable. The fork DROPS the
    // runt (openclaw lesson) instead of re-emitting raw markup — flushing verbatim
    // is exactly what leaks DSML tags into the chat at long context.
    const deltas = [tag("tool_calls"), tag("invoke", 'name="bash"'), param("command", "pwd")]
    const events = await run(deltas)
    expect(toolCalls(events)).toHaveLength(0)
    expect(streamedText(events)).not.toContain("DSML")
    expect(streamedText(events)).toContain("[removed malformed markup]")
    expect(finishOf(events).finishReason.unified).toBe("stop")
  })

  test("stream-empty-invoke-fallback", async () => {
    const deltas = [block([tag("invoke", 'name="x"')])]
    const events = await run(deltas)
    expect(toolCalls(events)).toHaveLength(0)
    expect(finishOf(events).finishReason.unified).toBe("stop")
  })

  test("stream-surrounding", async () => {
    const events = await run(["a ", block([invoke("bash", [param("command", "pwd")])]), " b"])
    expect(toolCalls(events)).toHaveLength(1)
    expect(streamedText(events)).toBe("a  b")
  })

  test("stream-orphan-invoke (V9 degradation)", async () => {
    const events = await run(["pre ", invoke("edit", [param("path", "Main.kt")]), " post"])
    const calls = toolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolName).toBe("edit")
  })

  test("lifecycle ordering around each call", async () => {
    const events = await run([block([invoke("a", [param("x", "1")])])])
    expect(lifecycle(events)).toEqual(["tool-input-start", "tool-input-delta", "tool-input-end"])
  })

  test("stream-buffer-cap redacts the runt (fork)", async () => {
    const huge = tag("tool_calls") + "x".repeat(70 * 1024)
    const events = await run([huge])
    expect(toolCalls(events)).toHaveLength(0)
    // Fork: the over-cap runt is redacted, not echoed as raw markup.
    expect(streamedText(events)).not.toContain("DSML")
  })

  test("stream-eager-stop: prose opener flushes early, nothing held", async () => {
    // A wrapped-candidate opener that never develops call structure: the hold
    // must release as text (eager stop), not wait for text-end.
    const events = await run(['<parameter name="oops"> just prose, no structure here'])
    expect(toolCalls(events)).toHaveLength(0)
    // Text is emitted (possibly across two deltas: head + flushed hold), fully.
    expect(streamedText(events)).toBe('<parameter name="oops"> just prose, no structure here')
    expect(finishOf(events).finishReason.unified).toBe("stop")
  })

  test("stream-transition: foreign part flushes held text first", async () => {
    const middleware = createDsmlStreamMiddleware()
    const parts: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello " },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "thinking" },
      { type: "reasoning-end", id: "r1" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} as never },
    ]
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(c) {
        for (const p of parts) c.enqueue(p)
        c.close()
      },
    })
    const wrapped = await middleware.wrapStream!({
      doStream: async () => ({ stream }),
      doGenerate: (async () => ({})) as never,
      params: {} as never,
      model: {} as never,
    })
    const events: LanguageModelV3StreamPart[] = []
    const reader = wrapped.stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      events.push(value)
    }
    const order = events.map((e) => e.type)
    // "hello " text must precede the reasoning block (no reordering).
    expect(order.indexOf("text-delta")).toBeLessThan(order.indexOf("reasoning-start"))
    expect(streamedText(events)).toBe("hello ")
  })
})
