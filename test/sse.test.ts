/**
 * SSE rewriter tests. Mirror of test/stream.test.ts, asserting on the rewritten
 * OpenAI-Chat SSE bytes — the exact contract the native protocol parser reads.
 * Plus a golden run over the synthetic fixtures serialized as SSE.
 */

import { describe, expect, test } from "bun:test"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { SseDsmlRewriter } from "../src/sse.ts"
import { createDsmlStreamMiddleware } from "../src/middleware.ts"
import { BAR, block, invoke, marker, param, tag, text } from "./fixtures.ts"
import raw from "./golden/db-messages.json" with { type: "json" }

function sseText(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`
}

function sseFinish(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason, index: 0 }] })}\n\n`
}

/** Feed whole frames; split the byte stream awkwardly to simulate chunking. */
function runStream(bytes: string, split = 7): string[] {
  const rewriter = new SseDsmlRewriter()
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += split) {
    out.push(...rewriter.push(bytes.slice(i, i + split)))
  }
  out.push(...rewriter.flush())
  return out
}

/** Parse emitted frames back into events for assertions. */
function parseOut(frames: string[]): Array<{ content?: string; toolCall?: { name: string; args: string }; finish?: string }> {
  const events: Array<{ content?: string; toolCall?: { name: string; args: string }; finish?: string }> = []
  const calls = new Map<number, { name?: string; args: string }>()
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      const payload = line.startsWith("data:") ? line.slice(5).trimStart() : line
      if (!payload || payload === "[DONE]") continue
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>
      }
      const choice = event.choices?.[0]
      if (!choice) continue
      if (typeof choice.delta?.content === "string") events.push({ content: choice.delta.content })
      for (const tc of choice.delta?.tool_calls ?? []) {
        const entry = calls.get(tc.index) ?? { args: "" }
        if (tc.function?.name) entry.name = tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
        calls.set(tc.index, entry)
      }
      if (typeof choice.finish_reason === "string") events.push({ finish: choice.finish_reason })
    }
  }
  for (const call of calls.values()) {
    if (call.name) events.push({ toolCall: { name: call.name, args: call.args } })
  }
  return events
}

const textOf = (events: ReturnType<typeof parseOut>) =>
  events.filter((e) => e.content !== undefined).map((e) => e.content as string).join("")
const callsOf = (events: ReturnType<typeof parseOut>) => events.filter((e) => e.toolCall !== undefined)
const finishOf = (events: ReturnType<typeof parseOut>) => events.find((e) => e.finish !== undefined)?.finish

describe("sse rewriter", () => {
  test("plain text passes through with identical bytes", () => {
    const bytes = sseText("Hello, ") + sseText("world!") + sseFinish("stop") + "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes, 11))
    expect(textOf(events)).toBe("Hello, world!")
    expect(callsOf(events)).toHaveLength(0)
    expect(finishOf(events)).toBe("stop")
  })

  test("recovers a doubled-bar call split across chunks, flips finish", () => {
    const doubles = marker(BAR, 2)
    expect(doubles).toContain("DSML")
    const body = `<${doubles}tool_calls><${doubles}invoke name="bash"><${doubles}parameter name="command" string="true">ls -la</${doubles}parameter></${doubles}invoke></${doubles}tool_calls>`
    const bytes = sseText(body) + sseFinish("stop") + "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes, 13))
    const calls = callsOf(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolCall!.name).toBe("bash")
    expect(JSON.parse(calls[0]!.toolCall!.args)).toEqual({ command: "ls -la" })
    expect(textOf(events)).toBe("")
    expect(textOf(events)).not.toContain("DSML")
    expect(finishOf(events)).toBe("tool_calls")
  })

  test("recovers the wrapped-tool shape (DB degradation)", () => {
    const bytes = sseText(text("pre ", `<parameter name="edit">`, param("path", "Main.kt"), " post")) + sseFinish("stop") + "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes))
    const calls = callsOf(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolCall!.name).toBe("edit")
    expect(finishOf(events)).toBe("tool_calls")
  })

  test("unparseable markup passes through, finish untouched", () => {
    const bytes = sseText(text(tag("tool_calls"), tag("invoke", 'name="x"'))) + sseFinish("stop") + "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes))
    expect(callsOf(events)).toHaveLength(0)
    expect(finishOf(events)).toBe("stop")
  })

  test("non-SSE payloads pass through", () => {
    const rewriter = new SseDsmlRewriter()
    const out = [...rewriter.push('{"error":{"message":"boom"}}'), ...rewriter.flush()]
    expect(out.join("")).toContain("boom")
  })

  test("usage chunks pass through", () => {
    const bytes = sseText("hi") + `data: ${JSON.stringify({ usage: { prompt_tokens: 3 } })}\n\n` + sseFinish("stop") + "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes))
    expect(textOf(events)).toBe("hi")
  })

  test("combined content+finish in one event keeps both", () => {
    // Some gateways terminate the stream with content and finish_reason together.
    // Dropping either breaks the run ("stream ended without finish_reason").
    const bytes =
      sseText("done") +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: "stop", index: 0 }] })}\n\n` +
      "data: [DONE]\n\n"
    const events = parseOut(runStream(bytes))
    expect(textOf(events)).toBe("done!")
    expect(finishOf(events)).toBe("stop")
  })
})

describe("settled stats", () => {
  test("sse rewriter reports recovery counts once", () => {
    const seen: Array<{ calls: number; sawCandidate: boolean }> = []
    const rewriter = new SseDsmlRewriter({ onSettled: (s) => seen.push(s) })
    const bytes = sseText(block([invoke("bash", [param("command", "pwd")])])) + sseFinish("stop") + "data: [DONE]\n\n"
    for (let i = 0; i < bytes.length; i += 23) rewriter.push(bytes.slice(i, i + 23))
    rewriter.flush()
    rewriter.flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.calls).toBe(1)
    expect(seen[0]!.sawCandidate).toBe(true)
  })

  test("sse rewriter reports pure passthrough", () => {
    const seen: Array<{ calls: number; sawCandidate: boolean; redacted?: boolean; looping?: boolean }> = []
    const rewriter = new SseDsmlRewriter({ onSettled: (s) => seen.push(s) })
    rewriter.push(sseText("plain text here") + sseFinish("stop"))
    rewriter.flush()
    expect(seen).toHaveLength(1)
    // Pure passthrough: nothing held, nothing recovered, nothing redacted.
    expect(seen[0]).toEqual({ calls: 0, sawCandidate: false, redacted: false, looping: false })
  })

  test("middleware reports settled stats", async () => {
    const seen: Array<{ calls: number; sawCandidate: boolean; redacted?: boolean; looping?: boolean }> = []
    const middleware = createDsmlStreamMiddleware({ onSettled: (s) => seen.push(s) })
    const source = new ReadableStream<LanguageModelV3StreamPart>({
      start(c) {
        c.enqueue({ type: "stream-start", warnings: [] })
        c.enqueue({ type: "text-start", id: "t1" })
        c.enqueue({ type: "text-delta", id: "t1", delta: "just prose" })
        c.enqueue({ type: "text-end", id: "t1" })
        c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} as never })
        c.close()
      },
    })
    const wrapped = await middleware.wrapStream!({
      doStream: async () => ({ stream: source }),
      doGenerate: (async () => ({})) as never,
      params: {} as never,
      model: {} as never,
    })
    const reader = wrapped.stream.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    expect(seen).toEqual([{ calls: 0, sawCandidate: false, redacted: false, looping: false }])
  })
})

describe("parallel safety", () => {
  test("concurrent streams produce unique call ids", async () => {
    const bodies = Array.from(
      { length: 8 },
      (_, i) => block([invoke(`tool${i}`, [param("x", String(i))])]),
    )
    const runOne = async (body: string) => {
      const middleware = createDsmlStreamMiddleware()
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] })
          c.enqueue({ type: "text-start", id: "t1" })
          c.enqueue({ type: "text-delta", id: "t1", delta: body })
          c.enqueue({ type: "text-end", id: "t1" })
          c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} as never })
          c.close()
        },
      })
      const wrapped = await middleware.wrapStream!({
        doStream: async () => ({ stream }),
        doGenerate: (async () => ({})) as never,
        params: {} as never,
        model: {} as never,
      })
      const ids: string[] = []
      const reader = wrapped.stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === "tool-call") ids.push(value.toolCallId)
      }
      return ids
    }
    const all = (await Promise.all(bodies.map(runOne))).flat()
    expect(all).toHaveLength(8)
    expect(new Set(all).size).toBe(8)
  })

  test("concurrent sse rewriters keep separate state", () => {
    const a = new SseDsmlRewriter()
    const b = new SseDsmlRewriter()
    const outA = a.push(sseText(block([invoke("ta", [param("x", "1")])])) )
    const outB = b.push(sseText("plain prose, no markup here") + sseFinish("stop"))
    // A already resolved its complete block; B (plain prose) is unaffected.
    expect(a.recoveredCalls).toBe(true)
    expect(outA.join("")).not.toMatch(/DSML/)
    expect(b.recoveredCalls).toBe(false)
    const allB = outB.join("") + b.flush().join("")
    expect(allB).toContain("plain prose")
  })
})

describe("sse golden: DB session leaks", () => {
  interface GoldenMessage {
    seq: number
    finish: string
    text: string
  }
  const messages = raw as GoldenMessage[]

  for (const m of messages) {
    test(`seq ${m.seq}: recovers call end to end over SSE`, () => {
      // One content delta per 64 chars (coarse chunking: structure mostly whole).
      let bytes = ""
      for (let i = 0; i < m.text.length; i += 64) bytes += sseText(m.text.slice(i, i + 64))
      bytes += sseFinish("stop") + "data: [DONE]\n\n"
      const events = parseOut(runStream(bytes, 97))
      const calls = callsOf(events)
      expect(calls.length).toBeGreaterThan(0)
      expect(["edit", "shell"]).toContain(calls[0]!.toolCall!.name)
      expect(finishOf(events)).toBe("tool_calls")
      expect(textOf(events)).not.toMatch(/DSML/)
    })
  }

  test("mixed native + leaked call keeps both with distinct indexes", () => {
    // The provider emits a proper native call AND leaks a DSML block as text
    // (the Bedrock #45600 shape). Both must survive with distinct index/id.
    const nativeCall = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_native1", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }, index: 0 }],
    })}\n\n`
    const leak = sseText(text("checking: ", block([invoke("read", [param("path", "a.ts")])])))
    const bytes = nativeCall + leak + sseFinish("stop") + "data: [DONE]\n\n"
    const rewriter = new SseDsmlRewriter()
    const frames = [...rewriter.push(bytes), ...rewriter.flush()].join("")
    // Collect every (index, id/name, arguments) triple from the output stream.
    const seen: Array<{ index: number; id?: string; name?: string; args?: string }> = []
    for (const line of frames.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trimStart()
      if (!payload || payload === "[DONE]") continue
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
      }
      for (const tc of event.choices?.[0]?.delta?.tool_calls ?? []) {
        seen.push({ index: tc.index, id: tc.id, name: tc.function?.name, args: tc.function?.arguments })
      }
    }
    const byIndex = new Map<number, typeof seen>()
    for (const s of seen) byIndex.set(s.index, [...(byIndex.get(s.index) ?? []), s])
    // Native index 0 carries only the native call; synthetic lives elsewhere.
    const nativeParts = (byIndex.get(0) ?? []).filter((s) => s.id === "call_native1")
    expect(nativeParts.length).toBeGreaterThan(0)
    expect(nativeParts.every((s) => s.name === undefined || s.name === "bash")).toBe(true)
    const synthIndexes = [...byIndex.keys()].filter((i) => i !== 0)
    expect(synthIndexes.length).toBe(1)
    const synthParts = byIndex.get(synthIndexes[0]!)!
    // Name chunk carries the generated id; continuation chunks share the index.
    expect(synthParts.some((s) => s.name === "read")).toBe(true)
    const synthArgs = synthParts.map((s) => s.args ?? "").join("")
    expect(JSON.parse(synthArgs)).toEqual({ path: "a.ts" })
    // No native part may carry synthetic arguments and vice versa.
    expect(nativeParts.map((s) => s.args ?? "").join("")).not.toContain("a.ts")
  })

  test("block helper sanity", () => {
    expect(block([invoke("bash", [param("command", "pwd")])])).toContain("tool_calls")
  })
})
