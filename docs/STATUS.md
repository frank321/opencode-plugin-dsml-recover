# PROJECT STATUS / HANDOFF

> Read this first when resuming. It captures the goal, the design, every decision,
> current test state, and the exact next steps. Companion docs: `docs/PATTERNS.md`
> (variant catalogue) and `docs/TEST-MATRIX.md` (test ↔ behaviour map).

## 1. Goal

Build an **OpenCode V2 plugin** that fixes DeepSeek "DSML" tool calls that leak into
assistant **text** instead of being parsed as structured tool calls. Two consumers:
fix **new streams** and repair **old stored transcripts**.

## 2. Hard facts established (do not re-investigate)

- OpenCode has **no DSML handling** anywhere. Upgrading will not fix it.
  `grep -ri dsml` over the whole `v2` source = 0 hits. Installed binary = 0 hits.
- Installed OpenCode: **v2.0.18**. Latest stable `latest` = **2.0.22**. Nightly `dev`
  tag = `0.0.0-dev-*`. We target **2.0.22**.
- V2 source repo = `anomalyco/opencode`, **default branch `v2`** (HEAD 2026-10-04).
  Worktree: `/code/opencode-v2`. (The older `/code/opencode-src` is `sst/opencode`,
  branch `dev`, which is V1 — not what we build against.)
- Failing path in the user's real session: provider **`opencode-go`**, model
  **`deepseek-v4.1-flash`**, package **`@ai-sdk/openai-compatible`**, baseURL
  `https://opencode.ai/zen/go/v1`. The `opencode` (Zen) provider uses the same shape.
- Trigger (evidence from a real long-context DeepSeek session on
  `opencode-go/deepseek-v4.1-flash`): **all leaks happen late in a huge
  context** (seq 5177+ of ~5700 messages). Degradation:
  outer `<DSML tool_calls>` opener missing, `invoke` opener mangled to a bare
  `parameter name="edit"`, and only inner params carry the DSML token. `finish_reason`
  was `stop`. Matches vLLM #48931 / #54686.
- Two extra hypotheses confirmed: (a) the provider backend's **greedy text→tool-call
  extractor** can turn arbitrary prose containing a tool-call-shaped tag into a real
  call (we saw this with the user's own messages); (b) the extractor is the same layer
  that fails to parse legit DSML at long context.

## 3. Where to insert the middleware (verified against `/code/opencode-v2`)

Chain for the AI-SDK provider path:

```
@ai-sdk/openai-compatible SSE
  → LanguageModelV3 doStream()
  → LanguageModelV3StreamPart stream
  → [ctx.aisdk.hook("language") + wrapLanguageModel]   ← OUR MIDDLEWARE
  → streamPartEvents()  packages/core/src/aisdk.ts      ← OpenCode lowering
  → LLMEvent.toolCall / stepFinish
  → runner/step.ts  dispatches tool-call events
```

- Enter at **`ctx.aisdk.hook("language", ...)`** (PluginContext field `aisdk`, type
  `AISDKDomain` with `hook: ModelHooks<AISDKHooks>`). Replace `event.language` with
  `wrapLanguageModel({ model: event.language, middleware })`.
- We must return **AI-SDK `LanguageModelV3StreamPart`s**. OpenCode already converts
  `tool-input-start|delta|end` and `tool-call` into `LLMEvent.toolCall`, then
  `runner/step.ts:117` dispatches it. `finish.finishReason.unified` must become
  `"tool-calls"` (else runner sees `stop`/`unknown`).
- Other usable hooks if needed: `ctx.session.hook("http.response"|"http.request"|
  "context"|"retry"|"prompt")`, `ctx.event.subscribe`, `ctx.session.synthetic/prompt`,
  `ctx.storage`. Plugin package `@opencode/plugin` (v2.0.22), `Plugin.define({ id, setup })`.

## 4. Prior art (nothing to duplicate)

- **CherryStudio** (peer Electron app, NOT OpenCode): `deepseekDsmlParserPlugin.ts`,
  PR #14747. Streaming state machine + `wrapGenerate`. We port its algorithm.
- **openclaw** (peer agent): `packages/ai/src/transports/openai-completions-dsml.ts`
  + `deepseek-dsml-grammar.ts`. Doubled-bar markers, buffer cap, chunk boundary.
- **pi-dsml** (peer agent, npm `pi-dsml@0.0.1`, unpacked at
  `/tmp/opencode/package`): grammar with mangled ` calls>` variant, ranges model,
  code-fence guard, `string=false` JSON rule. We port its `parse.ts` shape.
- **vLLM #54686**: leak taxonomy (runaway name / mis-closed param / misspelled opener).
- **No OpenCode plugin exists** for this. Do not go looking again.

## 5. Repository layout (`/code/opencode-dsml-plugin`)

```
docs/PATTERNS.md      variant catalogue + reject arms + two-consumer model (source of truth)
docs/TEST-MATRIX.md   each behaviour ↔ test id
docs/STATUS.md        this file (handoff — read first after compaction)
src/grammar.ts        all regexes, each linked to a V# in PATTERNS.md
src/parse.ts          parseDsml(text)->{calls,ranges}, stripRanges, orphan rescue
src/middleware.ts     createDsmlStreamMiddleware() AI-SDK LanguageModelV3Middleware
src/index.ts          (TODO) Plugin.define: aisdk.language hook + fallback
src/fallback.ts       (TODO) Strategy A: event subscribe + synthetic resume + storage cap
src/prompt.ts         (TODO) correction directive text (see §8)
test/fixtures.ts      runtime fixture builders (never store a live DSML token)
test/parse.test.ts    28 parser tests — ALL PASS
test/stream.test.ts   11 streaming tests — ALL PASS
test/wrapper.test.ts  generate + wrapper delegation — ALL PASS
test/config.test.ts   config matrix, strict parsing, prompt guards, fallback, system nudge — ALL PASS
```

Total: **89 tests, 0 fail**. `tsc --noEmit` clean.

Golden verification against real captured failures (9 wrapped edit/shell leaks
from a long-context DeepSeek session, preserved as synthetic byte-faithful
fixtures in `test/golden/`):
all 9 failing messages now recover the intended call — 5× edit
(newString+oldString+path), 4× shell (command) — with the finish flipping to
`tool-calls` and no text lost. The dominant shape is V26 (wrapped tool); the fix
for the earlier 0-for-9 miss was two parser bugs found by the golden test itself:
orphan ranges shadowing the wrapped rescue (`insideBlock` now checks block ranges
only), and the markerless outer opener needing candidate-hold in the stream.

## 6. Current test state

`bun test` → **114/114 pass** (6 files). `./node_modules/.bin/tsc --noEmit` → clean.

Fixed during the streaming work: the streaming `drain` was flushing partial openers
(`<`, `<BAR`, `<BAR BAR DS`) as text instead of holding them — fixed with
`partialOpenerSuffix` hold-back (V17).

**Fork session (2026-10-13):** two separate fixes on top of upstream 0.2.0 —
1. **redact unresolved runts** (commit `45282c9`): unclosed/over-cap DSML is
   redacted, not re-emitted as raw markup.
2. **hold past the 1 KB eager window while a block opener is pending** (commit
   `e857663`, this session): the eager-stop guard was missing a `hasBlockOpen`
   term, so a mangled envelope with a live `tool_calls` opener but **no
   `parameter` opener** was flushed verbatim at ~1 KB — pre-empting the over-cap
   redaction. This was **the ~300k long-context leak**, reproduced and fixed.
   The old `stream-buffer-cap` test passed only because it fed 70 KiB in a single
   delta; two new **chunked-delivery** regression tests fail on the pre-fix code
   and pass now (see `test/stream.test.ts`, and `docs/RUNBOOK-FORK.md` §5).

## 7. Design decisions (locked)

- Parser is a **strict acceptor**: on doubt, strip noise or leave text; never execute a
  guessed tool. `v13-undeclared-tool` is intentionally kept (runtime answers
  "tool not found", a better feedback loop).
- `v10` orphan parameter → **strip only, no call** (no tool name). Do not emit `unknown`.
- `v11` mis-closed param → drop the runaway argument, keep the neighbour (vLLM rule).
- `v12` runaway invoke name (`name="tool {`) → no call, strip.
- Code fences are never parsed or stripped.
- Message that already has native tool calls → strip leaked text only, do not re-run.
- Strategy A live: on idle, if last assistant text ends in DSML, send a
  synthetic correction nudge, send-once per message via `ctx.storage`.

## 8. The correction prompt (decided: nudge only, no preventive directive)

> Outcome: the preventive directive was removed — only the recovery-failure
> nudge shipped (`recoveryNudge()` in `src/prompt.ts`, wired as `retry.nudge`
> + idle wake). Original requirement below for the record.

When the parser **cannot** recover a call, and as preventive guidance, inject a
directive telling the model to always emit tool calls in the correct format **with the
outer XML layer**. Text to be finalised in `src/prompt.ts`, shape:

- Preventive: added via `ctx.session.hook("context")` or a system instruction, telling
  the model the exact expected envelope (canonical single-bar, complete outer block,
  one `<invoke>` per call, `<parameter>` with `string="true"` for raw strings).
- Recovery-failure nudge: on a stream where DSML appeared but no call was recovered, or
  on session idle with leaked markup, send a short synthetic message: "Your last tool
  call was malformed (missing the outer block). Re-issue it using the correct format,
  wrapped in the outer `<DSML tool_calls>` layer, exactly once."

Exact wording + whether preventive injection is always-on or only for the DEESEEK
providers is **not yet decided** — ask the user.

## 9. Exact next steps

1. ~~Fix the 2 streaming tests~~ — done, 69/69 green.
2. ~~Write `src/index.ts`, `src/prompt.ts`, `src/fallback.ts`~~ — done.
3. ~~System-channel nudge + full strategy config matrix~~ — done (see §11).
4. Live-wire verification: restart the OpenCode service so the plugin entry in
   the global `opencode.jsonc` loads, then run a DeepSeek session and
   confirm `[dsml]` debug lines + recovery behaviour.
5. Update `docs/PATTERNS.md`/`TEST-MATRIX.md` as rows move from FAIL to PASS.

## 11. Feature report (final)

Per-request (in `context` hook, before the model call):

- **History sanitization** (`history.sanitize`, default on): strips leaked DSML
  spans from replayed assistant text. Fires only when a leak exists; deterministic
  given stored messages, so retries converge to identical bytes (cache-friendly).
  Never synthesizes calls (no double-execution).
- **Conditional nudge** (`retry.nudge`, default on): when the
  assembled history ends in *unrecoverable* DSML, pushes the correction as a
  **transient system instruction** — never persisted, auto-clears when the
  condition clears. Send-once per message (id, else content hash) via storage.

Per-response (live fix, `responseFix.enabled`, default on):

- **AI-SDK path**: buffers `text-delta` only, holds partial
  openers, resolves closed blocks immediately, emits `tool-input-*` + `tool-call`,
  flips `finish` to `tool-calls`. Zero calls → buffer emitted verbatim, finish
  untouched. 64 KiB cap → over-cap unclosed tail emitted as text. Zero request
  impact → zero cache impact. Same recovery for non-streaming results.
- **Native SSE path** (`http.response` rewrite, the one `opencode-go` uses):
  same parser, same policy on raw SSE bytes.

Retry safety net (`retry.enabled` + `retry.channel`, send-once per message):

- On session idle with unrecovered DSML last message: `channel:"system"` (default)
  sends a minimal synthetic wake ping (`"Resume the interrupted tool call."`) and
  the context hook attaches the full correction in system on the woken turn;
  `channel:"user"` sends the full correction as a synthetic user turn.
- One poke per message; a message that stays silent is left alone.

The fixed nudge text lives in `src/prompt.ts` (`recoveryNudge()`); tests assert
it contains no live marker bytes.

Caching verdict: only stable, deterministic bytes are ever added; nothing in the
plugin churns per-request content. The one real invalidation is the one-time shift
when the nudge first appears — expected and unavoidable for any fix, and
documented as acceptable.

Rejected alternative: `session.instructions.entry.put` as the nudge channel. It
renders into the system baseline (ideal placement), but the Promise plugin runtime
allowlists session methods and `instructions` is not exposed (type *and* runtime).
Revisit only if OpenCode exposes it to plugins.

## 10. Environment

- Bun 1.4.2. `bun test`, `./node_modules/.bin/tsc --noEmit` (tsgo unavailable here).
- Deps installed: `@ai-sdk/provider@3.0.18`, `@opencode/plugin@2.0.22`, `typescript`.
- Never write a literal DSML token into a source/doc file — the client/provider may
  parse it as a phantom tool call. Always build it via `test/fixtures.ts` or use the
  `‹DSML›` placeholder.
