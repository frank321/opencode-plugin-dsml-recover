# Test Matrix

One row per parser behaviour. Each row names a fixture (inline string or file under
`test/fixtures/`) and the assertion. Tests are numbered `V#`/`reject-*` to match
`docs/PATTERNS.md`.

Fixture convention: a **fixture is raw text built at runtime** so we can inject the real
`U+FF5C` bytes without this repository ever containing them literally; helpers in
`test/fixtures.ts` provide `m` (marker), `invoke`, `param`, `block`.

## Parser: `parseDsml(text)`

| ID | Fixture | Expect |
|----|---------|--------|
| `v1-canonical` | `block([invoke("bash", [param("command","ls -la")])])` | 1 call `{name:"bash", args:{command:"ls -la"}}`, 1 range covering block |
| `v2-doubled-bars` | same with doubled bars `m2` | 1 call |
| `v3-ascii-pipes` | same with `|DSML|` | 1 call |
| `v4-marker-space` | `< m " calls>"` (space before `calls`) | 1 call |
| `v5-truncated-tag` | block tag `calls` instead of `tool_calls` | 1 call |
| `v6-name-spacing` | `invoke name = "bash"` | 1 call |
| `v7-tool-call-singular` | block tag `tool_call` | 1 call |
| `v8-function-calls` | block tag `function_calls` | 1 call |
| `v9-orphan-invoke` | `invoke("edit",[param("path","a.kt")])` with **no** block | 1 call, range covers invoke |
| `v10-orphan-parameter` | `param("content","x")` only (no invoke) | 1 call named `unknown`? **NO** — see note |
| `v11-misspelled-closer` | `param("alpha",..)‹BAR›>‹BAR›parameter name="beta"..` | 2 calls: alpha + beta (not swallowed) |
| `v12-runaway-name` | `invoke("record_item {\\ncategory")` | 0 calls, range strips it |
| `v13-undeclared-tool` | `invoke("totally_made_up",[param("x","y")])` | 1 call kept |
| `v14-empty-name` | `invoke("",[param("x","y")])` | 0 calls, no infinite loop |
| `v15-unclosed` | `block-open + invoke("bash",..)` with no closes | calls from complete invokes only; remainder as text |
| `v16-truncated-invoke` | two invokes, 2nd missing `</invoke>` | 1 call (first) |
| `v18-surrounding` | `"before " + block + " after"` | text before/after preserved, block ranged |
| `v19-multiple` | two invokes in one block + two blocks | 4 calls |
| `v20-code-fence` | `"```\n" + block + "\n```"` | 0 calls, 0 ranges |
| `v21-eos` | `block + eosMarker` | eos in ranges |
| `v22-entities` | param value `a &amp; b &quot;q&quot;` | decoded `a & b "q"` |
| `v23-multiline-value` | `param` value with `\n` and indent | value preserved, only hug newlines removed |
| `v24-json-param` | `param` `string="false"` value `{"a":1}` | args[{a:1}] as object |
| `v25-raw-json-body` | invoke body `{"a":1}` no params | args `{a:1}` |
| `v26-wrapped-tool` etc. | markerless/markered outer + complete inners | call X recovered; plain prose / incomplete nesting untouched |
| `v27-bare-value-rescue` | bare-value orphan `parameter` + orphan closer + resolver key | 1 call (tool name in `name`); closer-swallow strips the trailing closer || `§22-fixed` | real leak (2026-10-17), resolver maps `shell`→`command` | 1 call, `</invoke>` + mangled ` calls>` stripped (text → `""`) |
| `§22-declines` | same leak, no resolver / unknown tool | 0 calls (never guess a key) |
| `§22-shape-B` | orphan `parameter name="path"`/`"newString"` (arg name, not tool) | 0 calls — resolver only keys real tool names |
| `§22-held-prefix` | leak minus its closer | 0 calls, 0 ranges (no authenticity signal) |
| `§21-regression` | prose merely mentioning `<parameter name="…">` | 0 calls, 0 ranges (fix must not reopen the fork's text-eating bug) |
| `schema-keys-single-arg` | tool schema: one required string arg | keyed (`shell`→`command`, `read`→`filePath`, `websearch`→`query`) |
| `schema-keys-multi-none-nonstring` | 3-required / no-`required` / non-string prop | declined (no key) |
| `schema-keys-absent-tools` | no tool list | empty map → decline everything |
| `schema-keys-merge` | live schema over static `bareValueKeys` | live key wins; live-only tools added |
| `reject-no-marker` | `"hello world"` | 0 calls, 0 ranges |
| `reject-not-dsml` | long prose, no marker | fast path (looksLikeDsml false) |
| `reject-empty-args` | `invoke("bash",[])` | 0 calls (nothing to run) |

**Note on `v10-orphan-parameter`:** a bare `parameter` with no enclosing invoke has no
tool name, so it cannot become a call. Decision: **strip the noise, emit no call**
(not `unknown`). Executing an `unknown` tool is worse than dropping an unusable
fragment. This row therefore expects `calls: []`, `ranges: [the parameter markup]`.

## Streaming: `createDsmlStreamMiddleware()`

| ID | Fixture | Expect |
|----|---------|--------|
| `stream-text-passthrough` | plain text deltas | all `text-delta` emitted, no tool parts |
| `stream-v2-recovered` | doubled-bar block split per token | `tool-input-start/delta/end` + `tool-call`, no leaked text |
| `stream-v17-chunk-split` | opener split `<`/`BAR`/`DSML`/… | recovered, no partial marker leaked |
| `stream-finish-rewrite` | recovered call, source finish `stop` | finish `tool-calls` |
| `stream-finish-untouched` | no DSML | finish stays `stop` |
| `stream-unclosed-fallback` | open block, then `text-end` | buffered text emitted verbatim, finish `stop` |
| `stream-empty-invoke-fallback` | closed block, unparseable | block re-emitted as text, finish `stop` |
| `stream-surrounding` | `"a " + block + " b"` | text `"a  b"`, 1 call |
| `stream-multiline-edit` | real captured edit shape (DB V9) | 1 `edit` call with correct args |
| `stream-orphan-invoke` | V9 degradation mid-stream | 1 call |
| `stream-buffer-cap` | >64 KiB unclosed | fallback to text, no unbounded growth |
| `stream-eager-stop` | prose opener, no structure | flushed early as text, nothing held |
| `stream-transition` | reasoning part mid-text | held text flushed first, order preserved |

## Settled stats (`onSettled`)

| ID | Fixture | Expect |
|----|---------|--------|
| `settled-recovery-counts` | SSE block with 1 recovered call | `{ calls: 1, sawCandidate: true }`, reported once |
| `settled-passthrough` | plain SSE text, middleware plain prose | `{ calls: 0, sawCandidate: false, redacted: false }` |

> `redacted` is set when a turn redacted leaked markup it could not recover. The
> retry safety net reads it because redaction erases the DSML marker from stored
> text, so `looksLikeDsml(transcript)` is false afterwards — without this flag the
> wake would never fire for the §22 case.

## Repair: `recoverStoredMessage(message)`

| ID | Fixture | Expect |
|----|---------|--------|
| `repair-strip-only` | assistant msg with native tool-call + leaked text | text stripped, calls **not** appended |
| `repair-append` | assistant msg with leaked call, no native | text stripped, call appended, `stopReason:"toolUse"` |
| `repair-thinking` | leaked block in a `thinking` part | thinking stripped |
| `repair-idempotent` | run twice | second run is a no-op |

> Status: the repair *parser* (`parseDsml` + `stripRanges`) is fully tested. The
> message-level append wrapper is intentionally **not** built: OpenCode persists
> assistant messages durably and the plugin has no safe write path for them, so
> repair happens at request time via history sanitization in the `context` hook
> (`src/index.ts`) instead of mutating stored messages.

## Config / modes

| ID | Fixture | Expect |
|----|---------|--------|
| `config-defaults` | `resolveConfig()` | both Zen providers, all flags on, debug off |
| `config-granular` | one parse flag off | others stay on |
| `config-layers` | each layer off | that layer disabled |
| `parse-flags-off` | complete block + all flags off | parses |
| `parse-orphan-off` | orphan invoke + flags off | no call |
| `prompt-no-marker` | recovery nudge | no live marker bytes, outer-layer rule stated |
| `fallback-*` | decide/messageText/send-once | nudge policy + send-once |
| `stalled-step-stop` | `session.step.ended`, `data.finish:"stop"` | stall → wake (session from `data.sessionID`) |
| `stalled-step-toolcall` | `session.step.ended`, `data.finish:"tool-calls"` | healthy → no wake |
| `stalled-step-legacy-idle` | `session.idle` / `session.status{idle}` | still qualifies (future runtime) |

## Wrapper: `wrapDsmlLanguageModel`

| ID | Fixture | Expect |
|----|---------|--------|
| `wrapper-stream` | fake model, block in stream | 1 tool-call, finish `tool-calls` |
| `wrapper-passthrough` | plain text | untouched |
| `wrapper-generate` | block in generate text | tool-call content part, finish `tool-calls` |

## Sources / provenance

Fixtures marked with a source are byte-faithful captures from that source; others are
constructed from the grammar. Provenance is recorded in `test/fixtures.ts` beside each.

- `[DB]` shapes observed in a real long-context DeepSeek session: wrapped
  edit/shell leaks with O(1000)-char multiline values and shell metachars
- `[vLLM]` vLLM #54686 leak classes (runaway name, mis-closed param, misspelled opener)
- `[OpenClaw]` openclaw #128858 doubled full-width bars
- `[Pi]` pi-dsml grammar (mangled ` calls>` variant)
- `[CS]` CherryStudio #14747 chunk-split SSE sample
