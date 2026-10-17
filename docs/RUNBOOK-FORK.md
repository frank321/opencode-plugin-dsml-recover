# RUNBOOK — running the fork and capturing a real DSML leak

> **Fork of `opencode-plugin-dsml-fix`.** This repo adds (a) a diagnostic capture
> layer and (b) a fix for the residual long-context leak (see
> `docs/FIX-eager-flush.md`). This file is only about **operating the fork**.
>
> ⚠️ **Never write a literal DSML token into a source or doc file.** The
> client/provider may parse it as a phantom tool call. Build tags at runtime
> (`test/fixtures.ts`) or use the `‹DSML›` placeholder. This applies to anything
> you paste into logs, docs, or fixtures.

---

## 1. What the fork adds over upstream 0.2.0

| Change | Where | Effect |
| :--- | :--- | :--- |
| `capture` option | `src/config.ts`, `src/debug-capture.ts` | NDJSON diagnostics → `/tmp/opencode/dsml-capture.log` |
| instrumented `drain()` | `src/middleware.ts` (AI-SDK), `src/sse.ts` (SSE) | records every branch decision + buffer length vs cap + held bytes |
| **redact unresolved runts** | both `emitResolved` + over-cap branches | unclosed/corrupt DSML is **redacted**, not re-emitted as raw markup |
| **hold past the 1 KB eager window while a block opener is pending** | eager-stop guard in `src/middleware.ts` + `src/sse.ts` (commit `e857663`) | a mangled envelope with a live block opener but no `parameter` opener is no longer flushed verbatim at ~1 KB; it is held to the cap and redacted. Fixes the **~300k leak** (runbook §5) |

All four changes are **observer/passthrough-safe**: prose never carries DSML
ranges, so normal text is byte-identical. Verified: `tsc --noEmit` clean,
**136/136 tests pass** (including two chunked-delivery regression tests for the
eager-flush fix, which fail on the pre-fix code).

---

## 2. Build

The upstream project builds with **bun**; `dist/` is gitignored, so **you must
build before OpenCode can load it**.

```sh
cd /path/to/opencode-plugin-dsml-recover
export PATH="$HOME/.bun/bin:$PATH"        # bun 1.4.x
bun install                                # once (types + deps)
npx --yes esbuild ./src/index.ts --bundle --format=esm --target=esnext \
  --platform=node --external:@opencode/plugin --external:@ai-sdk/provider \
  --outfile=./dist/index.js --banner:js='// @bun'
```

> `bun run build` also works and is the canonical command; the `esbuild` line is
> the equivalent used here when bun's build wrapper is unavailable. Output is a
> single ESM file (~47 KB). Confirm: `ls -la dist/index.js`.

**Rebuild after every `src/` edit** — OpenCode loads `dist/index.js`, never `src/`.

---

## 3. Point OpenCode at the fork

`~/.config/opencode/opencode.jsonc`:

```jsonc
"plugins": [
  {
    "package": "file:///path/to/opencode-plugin-dsml-recover",
    "options": {
      "providers": ["deepinfra"],
      "debug": false,
      "capture": true
    }
  }
],
```

- The loader accepts a **`file://` URL to the plugin directory** (it resolves the
  entrypoint via `package.json` `exports` → `./dist/index.js`). Absolute paths and
  `./relative` also work.
- `capture: true` turns on the NDJSON diagnostics. `debug: true` adds upstream's
  per-turn summary lines (separate; both are harmless).
- **Back up before editing**: `cp opencode.jsonc opencode.jsonc.bak.$(date +%Y%m%d_%H%M%S)`.

### Does a running session pick it up?

OpenCode watches configured plugin sources and re-activates on change
(`packages/core/src/plugin/supervisor.ts`), **but** a session already in flight
had its hooks bound at activation. **Start a NEW session** (or restart the
OpenCode app/server) to be certain the fork is what's loaded.

---

## 4. Confirm the fork is live

After starting a fresh session:

```sh
# (a) the loader logs the entrypoint — must point at the FORK, not the npm cache
grep -a "loading plugin" ~/.local/share/opencode/log/opencode.log | tail -3
#   want: entrypoint=file:///path/to/opencode-plugin-dsml-recover/...
#   NOT:  entrypoint=file:///Users/you/.cache/opencode/npm/opencode-plugin-dsml-fix@latest/...

# (b) the capture file grows once the fork sees a turn with a DSML candidate
mkdir -p /tmp/opencode
ls -la /tmp/opencode/dsml-capture.log
```

> ⚠️ **`loading plugin` is NOT reliable on its own (confirmed 2026-10-13).** Two
> catch it: (1) the long-running `opencode serve --service` process can predate a
> config change and keep the **npm-cache** entrypoint in its log lines long after
> the JSONC was repointed; (2) the **CLI role does not emit a `loading plugin`
> line at all** — so a fork loaded by an interactive `opencode` run leaves no such
> line. Observed case: the journal showed only npm-cache entrypoints while the
> fork was demonstrably active.
>
> **Ground truth is the fork's own log**, written unconditionally at `setup`:

```sh
# (c) THE reliable check — the fork's own setup breadcrumb.
#     Only the fork writes this file; the npm-cache dist has no such log path.
cat /tmp/opencode/dsml-plugin.log
#   want: recent `[dsml] setup enter dir=…` lines matching your session's start.
```

If (c) has no recent line, the fork did not load — check the JSONC parses, the
`file://` path is exact, and that `dist/index.js` exists (and is newer than
`src/`).


---

## 5. Watching for a leak

Run this in a second terminal while you work in OpenCode:

```sh
# live tail, one readable line per event
tail -f /tmp/opencode/dsml-capture.log | python3 -c '
import sys, json
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    if d["ev"] == "drain":
        print(f"[drain] {d[\"branch\"]:<18} len={d[\"len\"]:<7} closed={d[\"closed\"]} insideValue={d[\"insideValue\"]} overCap={d[\"overCap\"]}")
    elif d["ev"] == "emit":
        print(f"[emit]  {d[\"reason\"]} recovered={d.get(\"recoveredCalls\")} names={d.get(\"names\")} len={d[\"text\"][\"len\"]}")
'
```

### What signals a leak at ~300k context

| Capture signature | Meaning |
| :--- | :--- |
| many `branch=eager-flush` at `len≈1024+` | the **1 KB eager window** flushed a held DSML candidate as prose — **the ~300k mechanism, now CONFIRMED & FIXED** (see below) |
| `branch=overcap-flush` | a candidate exceeded **64 KiB** without closing |
| `emit reason=emit-resolved-unresolved-redacted` | the **fork's fix fired**: a runt was redacted (no raw tags leaked) |
| `emit reason=over-cap-flush` with `ranges>0` | same, on the over-cap path |
| `emit reason=emit-resolved-no-call` with `ranges=0` | **plain prose** — not a leak |

**To answer "is it the small buffer?"**: compare the `len` on leaking events. If
leaks cluster near **1024** → the eager window, not the 64 KiB cap. If near
**65536** → the cap.

> ✅ **RESOLVED (2026-10-13, commit `e857663`).** The offline sweep's guess was
> right: the leak is the **1 KB eager window**, not the cap. Root cause: the
> eager-stop guard was `!insideValue` only. When a **live block opener** is
> present but the mangled envelope has **no `parameter name=` opener yet**
> (long-context shape), the candidate flushed **verbatim** at ~1 KB — which also
> **pre-empted** the 64 KiB over-cap redaction (it never got a chance to run).
> The old `stream-buffer-cap` test passed only because it fed all 70 KiB in **one
> delta**; any real chunk size leaked all 71,698 raw chars. Fixed by adding
> `!hasBlockOpen` to the guard (both paths). If capture now shows
> `branch=hold-continue`/`overcap-flush` where it used to show `eager-flush` for
> a block-opener candidate, the fix is doing its job. `eager-flush` at `len≈1024`
> is now legitimate **only** for prose with no block opener.


---

## 6. Capturing a real fixture (the goal)

When a leak is suspected:

1. Note the **wall-clock time** and keep working — do **not** clear the session.
2. Grab the offending turn's raw bytes from the **capture log** — the `emit`
   records carry `text.head`/`text.tail` (600 chars each) plus exact length.
3. For full fidelity, pull the raw assistant text from the **OpenCode session
   store** around that timestamp:
   `sqlite3 ~/.local/share/opencode/opencode.db "SELECT ... FROM part ..."`
   (`part` holds assistant text; `message` holds metadata).
4. Save it as a **test fixture built at runtime** (never a literal token in a
   file — see the warning at the top). Replay through `parseDsml` and the
   middleware to confirm which shape escapes.

This fixture is the input the leak investigation had been waiting for.

> **Outcome of the 2026-10-13 capture (recorded here so the next session does not
> repeat the search).** The capture log covered a long-context session
> (754,739 input tokens) and **found no leaked envelope in the
> OpenCode store**: scanning all 11,189 `part` rows for a strong DSML signature
> (an `invoke`/`parameter` tag) returned **0**; the 14 weak hits were all `tool`
> parts — grep/read outputs that legitimately quote markup (e.g. Phi's
> `<<|tool|>>` token discussed in a doc). Real `sse` traffic in the window was
> 1,559 `emit-plain` + 4 `partial-opener-hold` drains, i.e. **no DSML candidate
> ever reached the buffer**. So there was no *captured real leak* to fixture.
>
> The leak was instead **reproduced from the code + the captured branch shape**:
> the one `branch=eager-flush` event in the log (a synthetic `aisdk` candidate at
> `len=1047`, `hasBlockOpen=true`, `insideValue=false`) named the exact failing
> guard, and a chunked replay of the same structure showed 71,698 raw chars
> leaking. Two runtime-built regression tests now lock it (runbook §5).
>
> **Why no real leak appeared:** two explanations are consistent and both are
> good news — either the leak simply has not recurred since the fork was wired,
> or the fork's redaction already strips it before it is stored. Distinguishing
> them needs a capture window that actually spans a ~300k turn. Keep capturing.


---

## 7. Safety / hygiene

- The capture log may contain **your session text**. It lives in `/tmp`
  (world-readable on some setups). Delete it when done: `rm -f /tmp/opencode/dsml-capture.log`.
- Never commit `dist/`, `node_modules/`, or the capture log (already gitignored).
- No secrets are involved; the plugin reads no credentials.

## 8. Rollback

```sh
# 1. restore the config
cp ~/.config/opencode/opencode.jsonc.bak.<TIMESTAMP> ~/.config/opencode/opencode.jsonc
# 2. start a new session (or restart the app/server)
```

Removing the `plugins` entry (or restoring the `"package": "opencode-plugin-dsml-fix"`
npm form) reverts to the unpatched plugin. The fork changes nothing outside itself.
