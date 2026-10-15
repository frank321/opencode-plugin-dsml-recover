# Fix: eager-flush leak of mangled DSML envelopes at long context

**Status:** fixed in this fork (commit `e857663`), test-covered, offered upstream.
**Scope:** `src/middleware.ts` (AI-SDK path) and `src/sse.ts` (SSE path).
**Upstream base:** `opencode-plugin-dsml-fix` v0.2.0 (`eb5fb39`).

> ⚠️ **Convention (repo-wide):** never write a literal DeepSeek DSML tag into a
> source or doc file — the client/provider may parse it as a phantom tool call.
> This document uses `‹DSML›` as a placeholder for the real markup token.

---

## 1. Symptom

In long sessions (observed at ~300k tokens of context), DeepSeek-V4.x emits a
tool call as **visible markup in assistant text** instead of a structured
`tool_calls` field. The turn stalls; the model then imitates its own broken
output on subsequent turns. Upstream's plugin is designed to catch exactly this —
but a specific *mangled* shape slipped through its "eager stop" and was **emitted
verbatim**.

## 2. Where upstream's guard let it through

The plugin buffers text while it *might* be DSML and flushes once it is clearly
prose. Two limits govern that:

| Constant | Value | Role |
| :--- | :--- | :--- |
| `EAGER_WINDOW` | `1024` | If a held candidate grows past this with no call structure forming, treat it as prose and flush. |
| `bufferLimit` | `65536` (64 KiB) | Hard cap on held text. |

Upstream's eager-stop guard (both paths) was:

```js
if (!final && !overCap && !insideValue && textBuffer.length > EAGER_WINDOW) {
  // flush the buffer as plain text
}
```

- `insideValue` is true only once a **`parameter name=` opener** is present.
- At long context, the provider **drops the `parameter` opener** (and often the
  outer opener) on the leaked envelope. So `insideValue` stayed **false**, the
  candidate grew past 1 KB, and the guard **flushed the raw markup as text**.

Critically, this flush happened **before** the buffer could reach the 64 KiB
`overCap` branch — so the plugin's own over-cap **redaction** (which would have
secreted the runt) **almost never ran**. The redaction code existed but had
effectively no reachable path for this shape.

## 3. Root cause

The eager-stop guard did not distinguish:

- **prose that merely resembles an opener** → should flush (its purpose); from
- **a genuine envelope whose inner `parameter` opener was mangled away** → should
  be **held to the cap** so the redaction/recovery branches can act.

The discriminator already existed in the buffer state — `hasBlockOpen` (a live
`‹DSML›tool_calls` / `‹DSML›function_calls` opener is present) — but it was **not
part of the guard**.

## 4. The fix (two co-requisite parts)

The fix is **not** a single guard term. Making the guard hold the envelope is
necessary but **not sufficient** — on its own it just defers the leak to the cap.
Two changes are required together:

### 4a. Hold past the eager window while a block opener is pending
Add `!hasBlockOpen` to the eager-stop guard, in **both** paths:

```js
// before
if (!final && !overCap && !insideValue &&            textBuffer.length > EAGER_WINDOW) { flush }
// after
if (!final && !overCap && !insideValue && !hasBlockOpen && textBuffer.length > EAGER_WINDOW) { flush }
```

**Rationale:** a pending block opener means this is a genuine envelope, not
prose — hold it to the cap. Prose with no block opener still eager-flushes, so
the eager-stop keeps its purpose (bounding the hold on opener-shaped prose).

### 4b. Redact the unresolved runt at the cap (co-requisite)
Once held, the envelope still has to be *disposed of* correctly. Upstream's
over-cap / unresolved branches **re-emitted the raw markup verbatim** — so
holding alone merely moved the leak to 64 KiB. The fix routes those branches
through the plugin's own `stripRangesWithNote` + `redactionNote`: an
unrecoverable runt is **redacted**, not echoed (the openclaw "delete, don't
recover" lesson). Well-formed leaks still recover normally (recover-first,
redact-the-runt).

> **Verified:** with the guard **alone** (4a) and no redaction, the mangled
> 8 KiB fixture is still emitted as visible markup — the regression test fails.
> Both parts are required for the test to pass.

Files: `src/middleware.ts` (guard ~line 302; redaction in the over-cap/unresolved
branches), `src/sse.ts` (guard ~line 414; same redaction).

## 5. Why our test suite missed it (and the new regression tests)

Upstream's existing `stream-buffer-cap` test fed all 70 KiB in **one delta**, so
the buffer jumped straight to `overCap` and the **redaction path ran** — the test
passed on the buggy code. Real streams arrive in small chunks, so the buffer
crosses the 1 KB eager window **first** and the old guard flushed.

Two chunked-delivery regression tests were added (both **fail on the pre-fix
code**, pass after):

- `stream-buffer-cap redacts the runt when delivered in realistic chunks`
- `stream-eager-open: block opener + dropped parameter opener is held, not flushed raw`

On the pre-fix code these leak ~71,698 raw characters; after the fix they are
redacted. Full suite: **114/114 pass**, `tsc --noEmit` clean.

| Shape | Before | After |
| :--- | :--- | :--- |
| block opener + `parameter` opener, long value, chunked | redacted | redacted |
| **block opener + NO `parameter` opener, chunked** | **leaked ~71.7k chars** | **redacted** |
| prose opener, no block opener | flushed as text | flushed as text (unchanged) |
| pure prose, any chunk size | byte-identical | byte-identical |

## 6. Field evidence

The `eager-flush` branch is the leak. A capture layer (added in this fork, see
below) recorded the trigger shape at ~300k context:
`src=aisdk, len=1047, cap=65536, hasBlockOpen=true, insideValue=false,
overCap=false` → `branch=eager-flush`. That is exactly the mangled envelope
described in §2, and it is the shape §4 now holds instead of flushing.

## 7. What in this repo is the *fix* vs fork-only tooling

The fix proper (guard 4a + redaction 4b):

- `src/middleware.ts`, `src/sse.ts` — the `!hasBlockOpen` guard **and** the
  over-cap/unresolved redaction.
- `test/stream.test.ts` — the two chunked regression tests.

Fork-only (diagnostics/support; not required by the fix):

- `capture` option + `src/debug-capture.ts` — NDJSON decision logging.
- The instrumented `drain()` calls that record branch decisions (these are
  interleaved with the fix hunks but are separable).
- `docs/RUNBOOK-FORK.md`, `docs/FIX-eager-flush.md` (this file).

## 8. Credit

Upstream: **`opencode-plugin-dsml-fix`** by **bendtherules** (MIT). The plugin's
buffering/parse/recover architecture — and the `EAGER_WINDOW` / `bufferLimit`
design this fix touches — are theirs. This change is a targeted bug-fix on top,
kept MIT and credited.
