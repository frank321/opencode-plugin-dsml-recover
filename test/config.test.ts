/** Config defaults, per-shape parse flags, prompt guards, and retry decisions. */

import { describe, expect, test } from "bun:test"
import { appliesToProvider, resolveConfig } from "../src/config.ts"
import { alreadySent, attemptKey, decideResume, messageText, needsSystemNudge, nudgeCapKey, turnId, wakeText } from "../src/fallback.ts"
import { block, invoke, param } from "./fixtures.ts"
import { parseDsml, redactionNote, stripRangesWithNote } from "../src/parse.ts"
import { containsLiveMarker, recoveryNudge } from "../src/prompt.ts"

describe("config", () => {
  test("defaults: everything protective on, only debug off", () => {
    const c = resolveConfig()
    expect([...c.providers]).toEqual(["opencode-go", "opencode"])
    expect(c.orphanInvoke).toBe(true)
    expect(c.looseParameters).toBe(true)
    expect(c.rawJsonBody).toBe(true)
    expect(c.wrappedTool).toBe(true)
    expect(c.responseFixEnabled).toBe(true)
    expect(c.bufferLimit).toBe(64 * 1024)
    expect(c.sanitizeEnabled).toBe(true)
    expect(c.retryEnabled).toBe(true)
    expect(c.retryNudgeEnabled).toBe(true)
    expect(c.retryChannel).toBe("system")
    expect(c.debug).toBe(false)
  })

  test("one parse shape can be switched off in isolation", () => {
    const c = resolveConfig({ parse: { wrappedTool: false } })
    expect(c.wrappedTool).toBe(false)
    expect(c.orphanInvoke).toBe(true)
  })

  test("whole layers switch off", () => {
    const c = resolveConfig({
      responseFix: { enabled: false },
      history: { sanitize: false },
      retry: { enabled: false, nudge: false },
    })
    expect(c.responseFixEnabled).toBe(false)
    expect(c.sanitizeEnabled).toBe(false)
    expect(c.retryEnabled).toBe(false)
    expect(c.retryNudgeEnabled).toBe(false)
  })

  test("retry channel selects delivery", () => {
    expect(resolveConfig({ retry: { channel: "user" } }).retryChannel).toBe("user")
  })

  test("empty providers disables scoping", () => {
    const c = resolveConfig({ providers: [] })
    expect(appliesToProvider(c, "opencode-go")).toBe(false)
  })

  test("provider scoping", () => {
    const c = resolveConfig()
    expect(appliesToProvider(c, "opencode-go")).toBe(true)
    expect(appliesToProvider(c, "opencode")).toBe(true)
    expect(appliesToProvider(c, "anthropic")).toBe(false)
    expect(appliesToProvider(c, undefined)).toBe(false)
  })
})

describe("parse flags", () => {
  const allOff = { orphanInvoke: false, looseParameters: false, rawJsonBody: false, wrappedTool: false }

  test("complete block still parses with every flag off", () => {
    const r = parseDsml(block([invoke("bash", [param("command", "pwd")])]), allOff)
    expect(r.calls).toHaveLength(1)
  })

  test("orphan invoke is not recovered with its flag off", () => {
    const r = parseDsml(invoke("edit", [param("path", "a")]), allOff)
    expect(r.calls).toHaveLength(0)
  })

  test("mis-closed parameter is not rescued with its flag off", () => {
    const a = `<\uFF5CDSML\uFF5Cparameter name="alpha" string="true">first</\uFF5CDSML\uFF5C>`
    const src = block([invoke("r", [a, param("beta", "second")])])
    const r = parseDsml(src, allOff)
    // Without the tolerant scan the strict result stands (runaway value).
    expect(r.calls.map((c) => c.name)).toEqual(["r"])
  })
})

describe("prompt", () => {
  test("nudge contains no live marker and states the outer-layer rule", () => {
    expect(containsLiveMarker(recoveryNudge("edit"))).toBe(false)
    expect(recoveryNudge()).toContain("outer")
  })
})

describe("retry", () => {
  test("no marker → no nudge", () => {
    expect(decideResume("hello world", false)).toEqual({ send: false, reason: "no-marker" })
  })

  test("recoverable text → no nudge (live fix owns it)", () => {
    const decision = decideResume(block([invoke("bash", [param("command", "pwd")])]), false)
    expect(decision.send).toBe(false)
    expect(decision.reason).toBe("already-recoverable")
  })

  test("unrecoverable markup → nudge with correction text", () => {
    const decision = decideResume("broken \uFF5CDSML\uFF5C tool_calls garbage", false)
    expect(decision.send).toBe(true)
    expect(decision.text).toContain("outer")
  })

  test("send-once: already poked → silence", () => {
    const decision = decideResume("broken \uFF5CDSML\uFF5C tool_calls garbage", true)
    expect(decision).toEqual({ send: false, reason: "already-sent" })
  })

  test("§22: redaction erased the marker → nudge still fires", () => {
    // The §22 real leak: the live fix REDACTED the markup it could not recover,
    // so the stored text is the marker-free note below. `looksLikeDsml` is false,
    // yet the turn genuinely stalled — the redaction signal must still wake it.
    const redactedText =
      "One failure — the archive test. Let me see what it caught.\n\n" +
      "<parameter name=\"shell\">cd /x && pytest -q 2>&1 | tail -18" +
      "[removed malformed markup]"
    expect(decideResume(redactedText, false, false)).toEqual({ send: false, reason: "no-marker" })
    const woken = decideResume(redactedText, false, true)
    expect(woken.send).toBe(true)
    expect(woken.text).toContain("outer")
  })

  test("§22: redaction signal is send-once per message", () => {
    const redactedText = "…| tail -18[removed malformed markup]"
    expect(decideResume(redactedText, true, true)).toEqual({ send: false, reason: "already-sent" })
  })

  test("attempt key is namespaced per message", () => {
    expect(attemptKey("s1", "m1")).not.toBe(attemptKey("s1", "m2"))
  })

  test("alreadySent reads the flag", () => {
    expect(alreadySent(undefined)).toBe(false)
    expect(alreadySent(false)).toBe(false)
    expect(alreadySent(true)).toBe(true)
    expect(alreadySent(1)).toBe(true)
  })

  test("messageText reads assistant text only", () => {
    expect(messageText({ role: "user", content: [{ type: "text", text: "hi" }] })).toBeUndefined()
    expect(messageText({ role: "assistant", content: [{ type: "text", text: "a" }] })).toBe("a")
  })

  test("messageText tolerates null text", () => {
    expect(messageText({ role: "assistant", content: [{ type: "text", text: null }] })).toBeUndefined()
  })
})

describe("system nudge", () => {
  const unrecoverable = `trailing \uFF5CDSML\uFF5C tool_calls garbage without structure`

  test("fires when history ends in unrecoverable DSML", () => {
    const nudge = needsSystemNudge([{ role: "assistant", content: [{ type: "text", text: unrecoverable }] }])
    expect(nudge?.text).toContain("outer")
    expect(nudge?.key).toBeTruthy()
  })

  test("silent for clean history", () => {
    expect(needsSystemNudge([{ role: "assistant", content: [{ type: "text", text: "done" }] }])).toBeUndefined()
  })

  test("silent when the live fix could recover it", () => {
    const nudge = needsSystemNudge([
      { role: "assistant", content: [{ type: "text", text: block([invoke("bash", [param("command", "pwd")])]) }] },
    ])
    expect(nudge).toBeUndefined()
  })

  test("prefers message id, falls back to content hash", () => {
    expect(nudgeCapKey({ id: "msg-1", role: "assistant", content: [{ type: "text", text: "x" }] })).toBe("msg-1")
    const a = nudgeCapKey({ role: "assistant", content: [{ type: "text", text: "same" }] })
    const b = nudgeCapKey({ role: "assistant", content: [{ type: "text", text: "same" }] })
    const c = nudgeCapKey({ role: "assistant", content: [{ type: "text", text: "different" }] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  test("wake text is minimal", () => {
    expect(wakeText().length).toBeLessThan(60)
  })

  test("turnId uses OpenCode's user message id", async () => {
    const { turnId } = await import("../src/fallback.ts")
    expect(
      turnId([
        { role: "user", content: [{ type: "text", text: "first" }], id: "msg-aaa" },
        { role: "assistant", content: [{ type: "text", text: "reply" }], id: "msg-bbb" },
        { role: "user", content: [{ type: "text", text: "second" }], id: "msg-ccc" },
      ]),
    ).toBe("msg-ccc")
    expect(turnId([])).toBe("no-user-turn")
    expect(
      turnId([{ role: "assistant", content: [{ type: "text", text: "x" }] }]),
    ).toBe("no-user-turn")
  })

  test("responseFix defaults on", () => {
    expect(resolveConfig().responseFixEnabled).toBe(true)
    expect(resolveConfig({ responseFix: { enabled: false } }).responseFixEnabled).toBe(false)
  })
})

describe("redaction note", () => {
  test("placeholder replaces each removed span", () => {
    expect(stripRangesWithNote("a <b>c", [{ start: 2, end: 7 }], "[removed malformed edit call]")).toBe(
      "a [removed malformed edit call]",
    )
    expect(stripRangesWithNote("a <b>c", [{ start: 2, end: 5 }])).toBe("a [malformed tool call removed]c")
  })

  test("note carries no marker bytes", () => {
    const out = stripRangesWithNote("x", [{ start: 0, end: 1 }], "[removed malformed edit call]")
    expect(containsLiveMarker(out)).toBe(false)
  })

  test("redactionNote names tools, caps length", () => {
    expect(redactionNote(["edit"])).toBe("[removed malformed edit call]")
    expect(redactionNote([])).toBe("[removed malformed markup]")
    expect(containsLiveMarker(redactionNote(["edit", "shell"]))).toBe(false)
  })
})
