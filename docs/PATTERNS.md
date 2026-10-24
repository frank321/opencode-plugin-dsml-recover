# DSML Tool-Call Pattern Catalogue

Single source of truth for what the parser **accepts**, what it **repairs**, what it
**rejects**, and which test proves each row. Every regex in `src/grammar.ts` must trace
to a row here. Add a row and a test before adding a pattern.

> **Provenance:** this catalogue derives from
> [`bendtherules/opencode-plugin-dsml-fix`](https://github.com/bendtherules/opencode-plugin-dsml-fix)
> (MIT), extended here with the V27 bare-value rescue and the associated reject arms.
> See [`README.md`](../README.md) → Credits & lineage.

> Writing rule for this file: never paste a live DSML token. The model may emit it and
> our own harness (or the provider's greedy extractor) will turn this document into a
> phantom tool call. Represent tokens with the placeholder `‹DSML›` and show the
> literal bytes as `U+FF5C` escapes. The parser tests are the place for real bytes.

## 0. Notation

- `BAR` = one full-width bar `U+FF5C` (`｜`) **or** one ASCII pipe `|`.
- `DSML` literal word.
- Canonical marker: `< BAR DSML BAR >` — e.g. `<‹DSML›tool_calls>`.
- Doubled marker (observed): `< BAR BAR DSML BAR BAR >`.
- In real bytes: `\uFF5C` repeated.

## 1. Canonical grammar

```
< MARKER tool_calls>
  < MARKER invoke name="TOOL">
    < MARKER parameter name="KEY" string="true">VALUE</ MARKER parameter>
    < MARKER parameter name="KEY" string="false">JSON</ MARKER parameter>
  </ MARKER invoke>
</ MARKER tool_calls>
```

- Outer block names: `tool_calls` (V4), `function_calls` (V3.2), and the mangled `calls`.
- Single or doubled bars; optional whitespace around the marker.
- `string="true"` → raw string value. `string="false"` → JSON value. Attribute absent →
  raw string (default). Quotes may be `"` or `'`.
- Invoke/param names may be quoted with `"`/`'` or be a bare token.

## 2. Leak / degradation variants (the real-world enemies)

These are the shapes observed in the wild, in the order a stream degrades. Source tags:
`[DB]` = captured in a real OpenCode session DB, `[vLLM]` = vLLM PR #54686,
`[OpenClaw]` = openclaw doubled-bar issue, `[Pi]` = pi-dsml grammar, `[CS]` = Cherry Studio.

| # | Variant | Shape | Handle by | Test |
|---|---------|-------|-----------|------|
| V1 | Canonical single-bar | `< BAR DSML BAR tool_calls>` complete | parse normally | `v1-canonical` |
| V2 | Doubled full-width bars | `< BAR BAR DSML BAR BAR tool_calls>` | marker accepts 1–2 bars | `v2-doubled-bars` |
| V3 | ASCII pipes | `< | DSML | tool_calls>` | marker accepts `|` | `v3-ascii-pipes` |
| V4 | Space inside marker | `< BAR DSML BAR  tool_calls>` / `calls` | trailing `\s*` + `calls` alt | `v4-marker-space` |
| V5 | Truncated block tag | `< BAR DSML BAR calls>` | `calls` alternative for `tool_calls` | `v5-truncated-tag` |
| V6 | Spaces around invoke name | `< BAR DSML BAR invoke name = "x">` | `\s+` around `name=` | `v6-name-spacing` |
| V7 | `tool_call` (singular) | `< BAR DSML BAR tool_call>` | block tag alt | `v7-tool-call-singular` |
| V8 | `function_calls` (V3.2) | `< BAR DSML BAR function_calls>` | block tag alt | `v8-function-calls` |
| V9 | **Missing outer opener** | invoke/parameter appear with no `tool_calls` block | implicit-block rescue | `v9-orphan-invoke` |
| V10 | **Missing invoke opener** | leaked `parameter` only, no `invoke name=` | implicit-invoke rescue | `v10-orphan-parameter` |
| V11 | Mis-spelled closer | `</ BAR DSML BAR >` (bar then `>`), swallowing next param | tolerant scan + drop runaway param | `v11-misspelled-closer` |
| V12 | Runaway invoke name | `invoke name="tool {` (JSON leaked into name) | reject call, strip text | `v12-runaway-name` |
| V13 | Undeclared tool | well-formed, name not in tool set | **keep call**; runtime answers "tool not found" | `v13-undeclared-tool` |
| V14 | Empty invoke name | `name=""` | reject (never trap buffer) | `v14-empty-name` |
| V15 | Unclosed block at end | opener, no closer, stream ends | flush as text, recover complete calls only | `v15-unclosed` |
| V16 | Truncated mid-invoke | invoke has no closing tag | drop partial invoke, keep earlier ones | `v16-truncated-invoke` |
| V17 | Chunk-split opener | `<` `BAR` `DSML` … across deltas | suffix-prefix buffering | `v17-chunk-split` |
| V18 | Text before/after block | prose + block + prose | preserve prose, excise block | `v18-surrounding` |
| V19 | Multiple invokes / blocks | 2+ calls in one or many blocks | parse all | `v19-multiple` |
| V20 | Inside fenced code | grammar shown in ``` fence | **ignore** (no parse, no strip) | `v20-code-fence` |
| V21 | Trailing `‹EOS›` token | `…</…tool_calls>‹EOS›` | strip EOS token | `v21-eos` |
| V22 | HTML entities in values | `&quot;` `&amp;` `&lt;` | decode entities | `v22-entities` |
| V23 | Multi-line / heredoc value | value contains newlines, indentation | preserve verbatim except hugging newline | `v23-multiline-value` |
| V24 | JSON params | `string="false"` | `JSON.parse`, fall back to raw on failure | `v24-json-param` |
| V25 | Raw JSON body (no params) | invoke body is a bare `{...}` | fallback JSON parse | `v25-raw-json-body` |
| V26 | **Wrapped tool** (dominant real shape) | orphan `<parameter name="X">` (marker optional) containing ≥1 complete inner `<MARKER parameter>` | recover call X with inner args (V13 policy: runtime validates) | `v26-*` |
| V27 | **Bare-value orphan** (first real field leak, 2026-10-17) | orphan `<parameter name="X">VALUE</parameter>` with **no inner params**, followed by an orphan invoke/block closer; the argument **key** is not in the bytes | recover call X when a key can be derived for it from the session's live tool schema (exactly one required string arg: `shell`→`command`, `read`→`filePath`, `websearch`→`query`); otherwise **decline → redact** | `v27-*`, `§22-*` |

## 3. Reject arms (never emit a call)

The parser is a **strict acceptor**. When in doubt it does not execute; it either strips
noise or leaves text alone. This is deliberate: a false positive executes an arbitrary
tool the model never asked for.

| Reject arm | Rationale | Test |
|-----------|-----------|------|
| No DSML marker anywhere | fast path, zero cost | `reject-no-marker` |
| Text inside a code fence | docs/examples must not execute | `v20-code-fence` |
| Complete call but empty name | unusable, and must not trap buffer | `v14-empty-name` |
| Invoke with no parseable parameter and no JSON body | nothing to run | `reject-empty-args` |
| V27 bare-value orphan with no derivable key | a wrong key is worse than a redaction; never guess a key | `§22-declines` |
| Native tool calls already present on the message | strip text only, do not double-run | `reject-native-present` |
| `looksLikeDsml` false (no `DSML`/`end-of-sentence`) | skip whole pipeline | `reject-not-dsml` |

## 4. Transition: removal in old transcripts vs. rejection in new streams

The same engine serves **two consumers**:

1. **Streaming (new turns, `ctx.aisdk.language`)** — convert a DSML block into a real
   `tool-call` part *before* OpenCode's lowering, and rewrite `finishReason` to
   `tool-calls`. The block must never reach the transcript.
2. **Stored transcript repair (old sessions)** — walk existing messages, excise DSML
   spans, and (for messages that never got a native call) synthesize the missing call.

Both consume the **same `parseDsml(text) -> { calls, ranges }`** function. The only
difference is the sink:

- Stream sink: buffer `text-delta`, emit `tool-input-*` + `tool-call` for each call,
  drop `ranges` from the emitted text, set `finish` to `tool-calls` if any call.
- Repair sink: `stripRangesWithNote` for display (short inline note naming the
  removed tool when known, e.g. `[removed malformed edit call]`), append calls if
  none were native.

Because both share the parser, a variant is "supported" only when both sinks agree, and
the test table covers both.

## 5. Streaming buffer policy

- Hold text ONLY from the first byte that could open a call: a DSML opener, a
  partial-opener suffix (`<`, `<BAR`, `<parameter name="sh`, …), or a wrapped-tool
  candidate (`<parameter name="X">` with or without marker). Everything before it is
  emitted immediately, every chunk — plain prose is never buffered.
- Eager stop: a held candidate that produces no complete parameter-open within
  1024 chars is prose — flush as text and resume scanning fresh. Once a complete
  parameter is open (inside a value), only the 64 KiB cap bounds the hold.
- Transitions: any non-text part (reasoning, native tool parts) flushes held text
  FIRST, preserving transcript order.
- End-of-text guarantee: `text-end` / `finish` / stream flush always resolve the
  buffer — recovered calls plus verbatim remainder — so the buffer always ends
  empty and no text is ever lost.
- Trailing markup noise (`</invoke>` / `</calls>` arriving after an already
  recovered call) is dropped, not leaked.

## 6. Loop degeneracy — a failure mode with NO markup (2026-10-23)

Found live: DeepSeek V4.1 (DeepInfra) at ~520k cached context during a 688-turn
coding session. Distinct from every variant in §2: there is no
markup anywhere, so the parser and this document's grammar never apply and every
turn logs `passthrough`.

- **Shape.** One short imperative sentence re-emitted dozens of times inside a
  single assistant text part ("Let me do it.", "OK.", "Running:"). Observed at
  39, 37, 100 and 93 repeats; early turns carried a valid `shell` tool call
  alongside the filler (`finish=tool-calls`), later turns degraded to
  `finish=stop` with NO tool call — the true stall — often ending with an
  apology that promised a tool call that never came.
- **Why it loops.** Each turn's output is narrated intent only; no tool result
  ever lands, so the next request replays the same state and the model regenerates
  the same scaffolding. Long idle polls (`sleep 1500; ssh …`) between turns fed
  near-identical context repeatedly.
- **Recovery is impossible from the bytes.** In the `stop` turns there is no
  call to recover — suppression (collapse the filler) and interruption
  (action-demand wake) are the only levers. In the `tool-calls` turns the call
  already executes; suppressing the filler is cosmetic but stops the transcript
  pollution that reinforces the pattern.
- **Guard (`src/loopguard.ts`, `loopGuard` option, off by default).** Detector:
  a block ≥300 chars whose most-common non-blank line repeats ≥8×, or ≥800 chars
  with <15% unique lines. Tuned so the real corpus flags exactly its 6 loop
  messages out of 688, and normal prose, code, tables, and tool-result logs pass
  clean. Emission: plain text is held in a bounded 1 KiB window on the
  no-candidate path so classification can happen before the filler streams out;
  collapsed text keeps the leading intent line plus one `[loop suppressed]`
  marker. Wake: like the §22 redaction signal, the loop flags the session so
  `decideResume` fires — a pure loop gets `loopNudge()` (demand one concrete
  action), never the markup fixer.
