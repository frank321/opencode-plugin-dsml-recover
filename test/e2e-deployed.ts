/**
 * End-to-end check of the DEPLOYED bundle (dist/index.js), not src.
 *
 * The running OpenCode service loads `dist/index.js` (package `exports`). This
 * harness imports that exact artifact and runs the §22 real-leak shape — plus
 * the arg-name shape — through the streaming middleware, so we prove the
 * restarted service actually carries the closer-swallow fix.
 *
 * Run: bun run test/e2e-deployed.ts   (after `bun run build`)
 */
// dist ships no .d.ts; this harness intentionally loads the built artifact.
// @ts-expect-error deployed bundle has no type declarations
import { createDsmlStreamMiddleware } from "../dist/index.js"

const BAR = String.fromCharCode(0xff5c)
const marker = `${BAR}DSML${BAR}`

// §22 real leak shape: markerless bare-value parameter + orphan </invoke> + mangled closer.
const closer = `</${marker}calls>`
const realLeak =
  `<parameter name="shell">` +
  "cd /x && pytest -q 2>&1 | tail -18" +
  `</parameter>\n</invoke>\n` +
  closer

// The arg-name shape (the one that keeps stalling): name holds an ARG, not a tool.
const argNameShape =
  `<parameter name="path" string="true">` + "/path/to/x.ts" + `</parameter>\n</invoke>\n` + closer

type Part = { type: string; [k: string]: unknown }

async function runThrough(leak: string, keys: Record<string, string>) {
  const mw = createDsmlStreamMiddleware({
    resolveBareValueKey: (n: string) => keys[n],
  } as never)
  const seen: Part[] = []
  const source = new ReadableStream<Part>({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] })
      c.enqueue({ type: "text-start", id: "t1" })
      c.enqueue({ type: "text-delta", id: "t1", delta: leak })
      c.enqueue({ type: "text-end", id: "t1" })
      c.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: {} })
      c.close()
    },
  })
  const wrapped = await (mw as never as { wrapStream: (a: unknown) => Promise<{ stream: ReadableStream<Part> }> }).wrapStream({
    doStream: async () => ({ stream: source }),
    doGenerate: async () => ({}),
    params: {},
    model: {},
  })
  const reader = wrapped.stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen.push(value)
  }
  const text = seen
    .filter((p) => p.type === "text-delta")
    .map((p) => String((p as { delta?: string }).delta ?? ""))
    .join("")
  const calls = seen.filter((p) => p.type === "tool-call")
  const finish = seen.find((p) => p.type === "finish") as { finishReason?: { unified?: string } } | undefined
  return { text, calls, finish: finish?.finishReason?.unified }
}

const a = await runThrough(realLeak, { shell: "command", read: "filePath" })
console.log("--- §22 real leak (shell → command) ---")
console.log("calls:", JSON.stringify(a.calls))
console.log("finish:", a.finish)
console.log("text (no raw markup / no closer should survive):", JSON.stringify(a.text))

const b = await runThrough(argNameShape, { shell: "command", read: "filePath" })
console.log("\n--- arg-name shape (path) — expected to DECLINE ---")
console.log("calls:", JSON.stringify(b.calls))
console.log("finish:", b.finish)
console.log("text (redaction note expected):", JSON.stringify(b.text))

// Schema-derived keys now ALSO recover a `read` leak (previously config-only).
const readLeak =
  `<parameter name="read">` + "/etc/hosts" + `</parameter>\n</invoke>\n` + closer
const c = await runThrough(readLeak, { shell: "command", read: "filePath" })
console.log("\n--- read leak (schema-derived filePath) ---")
console.log("calls:", JSON.stringify(c.calls))
console.log("finish:", c.finish)

// `edit` (3 required args) must still decline even with schema keys present.
const editLeak =
  `<parameter name="edit">` + "x" + `</parameter>\n</invoke>\n` + closer
const d = await runThrough(editLeak, { shell: "command", read: "filePath" })
console.log("\n--- edit leak (3 required args) — expected to DECLINE ---")
console.log("calls:", JSON.stringify(d.calls))

// Meaningful invariants: the call recovers, the raw closer is gone (only
// whitespace may remain), and the finish flips to tool-calls.
const noRawCloser = !a.text.includes("</") && !a.text.includes("parameter") && a.text.trim() === ""
const passA = a.calls.length === 1 && a.finish === "tool-calls" && noRawCloser
const passB = b.calls.length === 0
const passC = c.calls.length === 1 && c.finish === "tool-calls"
const passD = d.calls.length === 0
console.log(
  `\nRESULT: §22=${passA} argname-declines=${passB} read-schema-recovered=${passC} edit-declines=${passD}`,
)
process.exit(passA && passB && passC && passD ? 0 : 1)
