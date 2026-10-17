/**
 * Parser tests. One `test(...)` per row in docs/TEST-MATRIX.md.
 * Fixtures are built at runtime (test/fixtures.ts) so no live DSML token is stored.
 */

import { describe, expect, test } from "bun:test"
import { parseDsml, stripRanges } from "../src/parse.ts"
import { BAR, block, closeTag, eos, invoke, marker, markerAscii, markerDoubled, param, tag, text } from "./fixtures.ts"

const args = (calls: { name: string; arguments: Record<string, unknown> }[], i = 0) => calls[i]!.arguments
const one = (result: { calls: unknown[] }) => {
  expect(result.calls).toHaveLength(1)
  return result.calls[0] as { name: string; arguments: Record<string, unknown> }
}

describe("parseDsml — variants", () => {
  test("v1-canonical", () => {
    const src = text("before ", block([invoke("bash", [param("command", "ls -la")])]), " after")
    const r = parseDsml(src)
    expect(one(r).name).toBe("bash")
    expect(args(r.calls)).toEqual({ command: "ls -la" })
    expect(r.ranges).toHaveLength(1)
    expect(stripRanges(src, r.ranges)).toBe("before  after")
  })

  test("v2-doubled-bars", () => {
    const m = markerDoubled()
    const r = parseDsml(block([invoke("bash", [param("command", "pwd", { m })], { m })], { m }))
    expect(one(r).name).toBe("bash")
  })

  test("v3-ascii-pipes", () => {
    const m = markerAscii()
    const r = parseDsml(block([invoke("bash", [param("command", "pwd", { m })], { m })], { m }))
    expect(one(r).name).toBe("bash")
  })

  test("v4-marker-space (space before mangled tag)", () => {
    // <BAR DSML BAR  calls>
    const open = `<${marker()} calls>`
    const close = `</${marker()} calls>`
    const src = open + invoke("bash", [param("command", "pwd")]) + close
    const r = parseDsml(src)
    expect(one(r).name).toBe("bash")
    expect(stripRanges(src, r.ranges)).toBe("")
  })

  test("v5-truncated-tag (bare `calls`)", () => {
    const r = parseDsml(block([invoke("bash", [param("command", "pwd")])], { kind: "calls" }))
    expect(one(r).name).toBe("bash")
  })

  test("v6-name-spacing", () => {
    const src = `${tag("tool_calls")}<${marker()}invoke name = "bash">${param("command", "pwd")}${closeTag("invoke")}${closeTag("tool_calls")}`
    const r = parseDsml(src)
    expect(one(r).name).toBe("bash")
  })

  test("v7-tool-call-singular", () => {
    const r = parseDsml(block([invoke("read", [param("path", "a.ts")])], { kind: "tool_call" }))
    expect(one(r).name).toBe("read")
  })

  test("v8-function-calls (V3.2)", () => {
    const r = parseDsml(block([invoke("glob", [param("pattern", "*.ts")])], { kind: "function_calls" }))
    expect(one(r).name).toBe("glob")
  })

  test("v9-orphan-invoke (no outer block)", () => {
    const src = text("prose ", invoke("edit", [param("path", "Main.kt")]), " tail")
    const r = parseDsml(src)
    expect(one(r).name).toBe("edit")
    expect(stripRanges(src, r.ranges)).toBe("prose  tail")
  })

  test("v10-orphan-parameter (no invoke) — strip, no call", () => {
    const src = text("x ", tag("parameter", 'name="edit" string="true"'), "body", closeTag("parameter"), " y")
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(0)
    expect(stripRanges(src, r.ranges)).toBe("x  y")
  })

  test("v11-misspelled-closer does not swallow the next parameter", () => {
    // <BAR DSML BAR parameter name="alpha" string="true">first</BAR DSML BAR>  <BAR DSML BAR parameter name="beta" ...>second...
    const a = `<${marker()}parameter name="alpha" string="true">first</${marker()}>`
    const b = param("beta", "second")
    const src = block([invoke("record_item", [a, b])])
    const r = parseDsml(src)
    expect(one(r).arguments).toEqual({ beta: "second" })
  })

  test("v12-runaway-name — no call, strip", () => {
    const src = text("x ", tag("invoke", 'name="record_item {"'), "\ncategory: Dexes</plan>")
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(0)
    expect(r.ranges.length).toBeGreaterThan(0)
  })

  test("v13-undeclared-tool is kept", () => {
    const r = parseDsml(block([invoke("totally_made_up", [param("x", "y")])]))
    expect(one(r).name).toBe("totally_made_up")
  })

  test("v14-empty-name — no trap", () => {
    const r = parseDsml(block([invoke("", [param("x", "y")])]))
    expect(r.calls).toHaveLength(0)
  })

  test("v15-unclosed block flushes, keeps complete invokes", () => {
    const open = tag("tool_calls")
    const src = text("p ", open, invoke("bash", [param("command", "pwd")]), " trailing")
    const r = parseDsml(src)
    expect(one(r).name).toBe("bash")
    // Everything from the opener to the end is ranged away.
    expect(stripRanges(src, r.ranges)).toBe("p")
  })

  test("v16-truncated-invoke keeps earlier calls", () => {
    const open = tag("tool_calls")
    const src = text(open, invoke("a", [param("x", "1")]), tag("invoke", 'name="b"'), param("y", "2"))
    const r = parseDsml(src)
    expect(r.calls.map((c) => c.name)).toEqual(["a"])
  })

  test("v18-surrounding text preserved", () => {
    const src = text("hello ", block([invoke("bash", [param("command", "pwd")])]), " world")
    const r = parseDsml(src)
    expect(stripRanges(src, r.ranges)).toBe("hello  world")
  })

  test("v19-multiple invokes and blocks", () => {
    const src = text(
      block([invoke("a", [param("x", "1")]), invoke("b", [param("y", "2")])]),
      " mid ",
      block([invoke("c", [param("z", "3")]), invoke("d", [param("w", "4")])]),
    )
    const r = parseDsml(src)
    expect(r.calls.map((c) => c.name)).toEqual(["a", "b", "c", "d"])
  })

  test("v20-code-fence ignored", () => {
    const src = text("```\n", block([invoke("bash", [param("command", "rm -rf /")])]), "\n```")
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(0)
    expect(r.ranges).toHaveLength(0)
  })

  test("v21-eos stripped", () => {
    const src = text(block([invoke("a", [param("x", "1")])]), eos())
    const r = parseDsml(src)
    expect(one(r).name).toBe("a")
    expect(stripRanges(src, r.ranges)).toBe("")
  })

  test("v22-entities decoded", () => {
    const r = parseDsml(block([invoke("bash", [param("command", "a &amp; b &quot;q&quot;")])]))
    expect(one(r).arguments).toEqual({ command: 'a & b "q"' })
  })

  test("v23-multiline value preserved", () => {
    const value = "\nline1\n  line2\n"
    const r = parseDsml(block([invoke("edit", [param("content", value)])]))
    expect(one(r).arguments).toEqual({ content: "line1\n  line2" })
  })

  test("v24-json parameter", () => {
    const r = parseDsml(block([invoke("q", [param("questions", '[{"a":1}]', { json: true })])]))
    expect(one(r).arguments).toEqual({ questions: [{ a: 1 }] })
  })

  test("v25-raw-json-body", () => {
    const src = `${tag("tool_calls")}<${marker()}invoke name="q">{"questions":[1,2]}${closeTag("invoke")}${closeTag("tool_calls")}`
    const r = parseDsml(src)
    expect(one(r).arguments).toEqual({ questions: [1, 2] })
  })

  test("v26-wrapped-tool (markerless outer, DB 5177 shape)", () => {
    const src = text(
      "prose ",
      `<parameter name="edit">`,
      param("newString", "a"),
      param("oldString", "b"),
      param("path", "f.kt"),
      `${closeTag("invoke")}`,
    )
    const r = parseDsml(src)
    expect(one(r).name).toBe("edit")
    expect(one(r).arguments).toEqual({ newString: "a", oldString: "b", path: "f.kt" })
    expect(stripRanges(src, r.ranges)).toBe("prose")
  })

  test("v26-wrapped-tool with marked outer (DB 5608 shape)", () => {
    const m = marker()
    const src = text(
      `<${m}parameter name="shell">`,
      param("command", "pwd"),
      `</${m}invoke>`,
    )
    const r = parseDsml(src)
    expect(one(r).name).toBe("shell")
    expect(one(r).arguments).toEqual({ command: "pwd" })
  })

  test("v26-plain prose parameter untouched", () => {
    const src = "the <parameter> element holds a value"
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(0)
    expect(r.ranges).toHaveLength(0)
  })

  test("v26-nested incomplete inner → no call", () => {
    const src = text(
      `<parameter name="edit">`,
      tag("parameter", 'name="newString" string="true"'),
      "half-written",
    )
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(0)
  })
})

/**
 * §22 — the FIRST REAL FIELD LEAK (2026-10-17T07:02:22Z, DeepInfra
 * DeepSeek-V4.1-Flash, long interactive session; session
 * `ses_eb7dc79ecffe4ly5TYBYH1za1V`). See server-manager docs/DSML_FIX_DESIGN.md §22.
 *
 * The provider dropped the outer block OPENER and the `invoke` opener, but KEPT a
 * MANGLED, MARKER-BEARING block closer (`</BAR DSML BAR calls>`) plus an orphan
 * `</invoke>` — leaving a markerless `<parameter name="shell">` whose raw value is
 * the only surviving argument. This is the "markerless orphan parameter with a
 * value" shape class (§22.5), NOT the V26 wrapped-tool shape.
 *
 * NB: this fixture SUPERSEDES a first-pass version that asserted the envelope had
 * no DSML marker at all. That was a capture-log artefact (the marker lived in the
 * closer, which arrived after the held buffer); see §22.2 correction. The bytes
 * are rebuilt at runtime (no literal marker token stored, per test/fixtures.ts).
 */
describe("§22 real leak — markerless orphan parameter (2026-10-17)", () => {
  // The persisted shape: markerless <parameter> + orphan </invoke> + mangled closer.
  const realLeak = text(
    `<parameter name="shell">`,
    "cd /Users/frank/git_repo/hermes-stock-watch && .venv/bin/python -m pytest ",
    "tests/test_deploy_scripts.py::test_archive_excludes_secrets_and_state -q 2>&1 | tail -18",
    `</parameter>`,
    "\n</invoke>\n",
    closeTag("calls"),
  )
  // The held-buffer prefix (closer not yet arrived) — what the capture log showed.
  const heldPrefix = realLeak.slice(0, realLeak.length - closeTag("calls").length)

  test("§22-fixed: the real leak recovers when the tool schema supplies the key", () => {
    // The fix: a bare-value orphan parameter + orphan closer, WITH a schema-derived
    // key for the tool, becomes a real call. `shell`→`command` is the actual case.
    const r = parseDsml(realLeak, { resolveBareValueKey: (n) => (n === "shell" ? "command" : undefined) })
    const call = one(r)
    expect(call.name).toBe("shell")
    expect(call.arguments).toEqual({
      command:
        "cd /Users/frank/git_repo/hermes-stock-watch && .venv/bin/python -m pytest " +
        "tests/test_deploy_scripts.py::test_archive_excludes_secrets_and_state -q 2>&1 | tail -18",
    })
    // Both the parameter element and the orphan closer are stripped from the text.
    expect(stripRanges(realLeak, r.ranges)).toBe("")
  })

  test("§22-declines: no resolver → no call (never guess a key)", () => {
    // Without a resolver the rescue declines and falls through to redaction,
    // reproducing the original miss. This is the §3.D invariant: an unresolvable
    // key must NOT be invented.
    const r = parseDsml(realLeak)
    expect(r.calls).toHaveLength(0)
  })

  test("§22-declines: an unknown tool name is not recovered", () => {
    const src = realLeak.replace(`name="shell"`, `name="mystery_tool"`)
    const r = parseDsml(src, { resolveBareValueKey: (n) => (n === "shell" ? "command" : undefined) })
    expect(r.calls).toHaveLength(0)
  })

  test("§22-held-prefix: no closer yet → no marker, no recovery", () => {
    // The capture-log artefact: at the moment of the drain the closer had not
    // arrived, so this prefix carries no DSML marker at all.
    const r = parseDsml(heldPrefix, { resolveBareValueKey: (n) => (n === "shell" ? "command" : undefined) })
    expect(r.calls).toHaveLength(0)
    expect(r.ranges).toHaveLength(0)
  })

  test("§22-discriminator: a trailing orphan closer is the authenticity signal", () => {
    // Prose does not close an invoke it never opened; the closer + resolver is
    // what separates a real call from quoted markup.
    expect(realLeak).toContain(`</invoke>`)
  })

  test("§21 regression guard: quoted markerless prose must stay untouched", () => {
    // The §22 fix must NOT reopen §21 (the fork eating quoted text). Prose that
    // merely mentions `<parameter name="…">` with no orphan invoke/block closer
    // must remain byte-identical and recover zero calls — even WITH a resolver.
    const prose = text(
      "An HTML ",
      `<parameter name="shell">`,
      "attribute is documented here.",
    )
    const r = parseDsml(prose, { resolveBareValueKey: (n) => (n === "shell" ? "command" : undefined) })
    expect(r.calls).toHaveLength(0)
    expect(r.ranges).toHaveLength(0)
  })

  test("v27-with-inner-params goes to V26, not the bare-value rescue", () => {
    // Guard the boundary: a body with complete inner params is V26 territory and
    // must not be double-claimed by the bare-value rescue.
    const src = text(
      `<parameter name="edit">`,
      param("path", "f.kt"),
      `${closeTag("invoke")}`,
    )
    const r = parseDsml(src, { resolveBareValueKey: () => "command" })
    const call = one(r)
    expect(call.name).toBe("edit")
    expect(call.arguments).toEqual({ path: "f.kt" })
  })
})

describe("parseDsml — reject arms", () => {
  test("reject-no-marker", () => {
    expect(parseDsml("hello world")).toEqual({ calls: [], ranges: [] })
  })

  test("reject-not-dsml fast path", () => {
    expect(parseDsml("a".repeat(10000))).toEqual({ calls: [], ranges: [] })
  })

  test("reject-empty-args", () => {
    expect(parseDsml(block([invoke("bash", [])])).calls).toHaveLength(0)
  })
})

describe("parseDsml — captured real shape", () => {
  test("stream-multiline-edit (DB seq 5177 shape) recovers the wrapped call", () => {
    // The real leak: an orphan `parameter name="edit"` wrapping complete inner
    // params. V26 recovers it as a real call (V13 policy: runtime validates).
    const src = text(
      `\u2039/analysis\u203a\n\n`,
      tag("parameter", 'name="edit"'),
      "\n",
      param("newString", "val x = 1"),
      "\n",
      param("oldString", "val x = 0"),
      "\n",
      closeTag("invoke"),
    )
    const r = parseDsml(src)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.name).toBe("edit")
    expect(stripRanges(src, r.ranges)).toBe("\u2039/analysis\u203a")
  })
})
