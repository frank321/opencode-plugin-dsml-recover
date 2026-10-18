# HANDOFF — the `tools=N` probe (upstream DSML feedback)

> **Purpose.** An upstream responder claimed malformed DSML output correlates
> with `tools count = 0` and asked whether an API format-conversion tool is in
> the path. We instrumented the plugin to record the outbound tool count so the
> claim can be tested empirically. This file is the record of that work and the
> exact procedure to confirm/refute it after a long session.
>
> **Status as of 2026-10-18:** code changed (two probes), tests pass, `dist`
> rebuilt (10:42), live config repointed to the local build. **Restart + fresh
> session still pending; awaiting a long session to produce log data.**
>
> **Upstream thread:** `anomalyco/opencode#50206` — "Malformed XML/DSML tool-call
> output from Opencode Go models". Our announcement is `#issuecomment-6240111938`
> (2026-10-17, `frank321`); the reply we are answering is `#issuecomment-6247081980`
> (2026-10-18, `heimoshuiyu`, a **contributor** — so the `tools count = 0`
> observation likely comes from real server-side request logs at their tier).
> **Do not post a reply until the log data below exists.**

---

## 1. What was asked (context)

A reply to our issue announcement said, in effect:

> From the request logs, almost all requests that hit malformed DSML output have
> tools count = 0. Can you check if you're using an API format conversion tool?
> It might be causing the issue.

Two distinct claims to separate:
1. **Correlation:** malformed DSML clusters on requests with `tools = 0`.
2. **Cause:** a format-conversion layer is responsible.

Our draft/announcement (`../announcement-draft.md`) argues the failure is in the
provider's text→tool-call extraction at long context. The two theories are not
mutually exclusive; this probe targets claim (1) for **our** path only.

## 2. What we can and cannot learn from this

- We **can** measure, per turn: outbound `tools` count vs. the response outcome
  (recovered / redacted / held-candidate / passthrough) on OpenCode → DeepInfra.
- We **cannot** speak to the responder's provider/conversion setup — different
  path. A result here does not prove or disprove their cause claim.
- **Key trap:** `tools=0` at the `context` hook may be legitimate (a genuine
  no-tools turn) *or* an artifact of the route not populating `event.tools`.
  Distinguish by comparing within a session that clearly uses tools. If a
  tool-using session shows `tools=0` on a leaking turn, something upstream is
  stripping the tools array — that is a real finding. If `tools=0` only appears
  on turns with no tool intent, a `tools=0 ↔ leak` link would be spurious.

## 3. The change — TWO measurement points

The `tools` question needs the count at two different stages, because they
localise a drop differently. Both are in `src/index.ts`.

### 3a. `context` hook — tools BEFORE request assembly

`ctx.session.hook("context")`. Before, the request line was emitted only when
`sanitizedMsgs > 0 || nudge` — so a `tools=0` turn that did nothing logged
nothing. Now it logs **unconditionally**:

```
request <session>/<message> tools=N sanitized=Xmsgs/Yparts nudge=yes|no
```

- `tools=N` = `Object.keys(event.tools ?? {}).length`.
- This is the count OpenCode *intends* to send, before it builds the wire request.

### 3b. `http.request` hook — tools AT DISPATCH (the wire probe)

`ctx.session.hook("http.request")` — same seam the plugin already uses for
`http.response`. The hook payload is `SessionHttpRequest`, whose `request` is a
real `Request` (`@opencode/plugin@2.0.22`, `dist/promise/session.d.ts:65-71`).
We read the body from a **clone** (never the original — consuming it would break
inference) and log:

```
wire <session>/wire tools=N names=[shell,edit,...] messages=M
```

- Observer only, gated behind `config.debug`, body read is fire-and-forget so it
  never serialises the outbound request, and the request is never mutated.

### 3c. Reading the two together (this is the whole point)

| `context` tools | `wire` tools | Meaning |
| :--- | :--- | :--- |
| N > 0 | N > 0 | Tools intact at dispatch. A leak then is **downstream** of OpenCode (provider/network) — Theory A territory, or the provider dropping them after the wire. |
| N > 0 | **0** | OpenCode dropped the tools array **during request assembly**. A concrete, localisable OpenCode bug. |
| 0 | 0 | Tools were never populated for this turn. A different root cause again. |

Neither point reaches *inside* DeepInfra; a wire count of N>0 with a leak only
tells us the drop (if any) is provider-side, which we cannot see.

Verification at build time:
- `tsc --noEmit` clean.
- `bun test` → **136 pass, 0 fail**.
- `bun run build` → `dist/index.js` rebuilt (~54 KB, 2026-10-18 10:42); both
  `tools=` (context) and `wire ` (http.request) confirmed present in the bundle.

## 4. Deployment state (2026-10-18)

- **Live config:** `~/.config/opencode/opencode.jsonc`, plugin entry changed from
  the bare npm name to the local build:
  `"package": "file:///Users/frank/git_repo/opencode-plugin-dsml-recover"`.
  (A bare name resolves from the npm cache and would NOT load `dist/index.js`.)
- **Backup:** `~/.config/opencode/opencode.jsonc.bak.20261018_100347`.
- Live options already set: `"debug": true`, `"capture": true`, `"providers": ["deepinfra"]`.
- **Restart required, and the stale-service hazard is REAL here.** This machine
  runs a long-lived server: `opencode serve --service` (PID 84837, started Sat
  09AM) predating BOTH of today's builds (10:03 and 10:42). Per `RUNBOOK-FORK.md`
  §3/§4, such a process can keep stale plugin state and can log a stale
  `loading plugin` entrypoint. Options, per the runbook:
  - **Restart the whole OpenCode app/server** → sessions are torn down with it, so
    a separate "new session" step is not strictly needed (the process restart is
    the fresh-start). Keep the new `file://` repoint in the config.
  - **New session without a restart** works only if the plugin was re-activated;
    an in-flight session keeps hooks bound at activation.
  - **Ambiguous middle case (avoid):** restarting one process while an old session
    object survives → new breadcrumbs but OLD hooks. Verify per 5a, never trust
    `loading plugin`.
- The `file://` repoint is what makes the new logging live; rebuilding `dist/`
  alone does nothing while the config uses the bare name.

## 5. How to confirm the issue after a long session

### 5a. Confirm the new build actually loaded

Ground truth is the fork's own breadcrumb, **not** `loading plugin` (see
`RUNBOOK-FORK.md` §4):

```sh
tail -5 /tmp/opencode/dsml-plugin.log     # want recent `[dsml] setup enter dir=…`
```

Then confirm both probes exist in the log:

```sh
grep -m3 'tools=' /tmp/opencode/dsml-plugin.log     # context-hook line
grep -m3 'wire '  /tmp/opencode/dsml-plugin.log     # http.request wire probe
```

If either never appears, the old build is still loaded (bad `file://` path,
stale `dist/`, or the session predates the restart). Note the wire probe only
fires for `kind=primary` requests on in-scope providers, with `debug: true`.

### 5b. Join the three lines per turn

There are now THREE related log lines, and they do **not** share one label:

| Line | Label shape | Example |
| :--- | :--- | :--- |
| `request …` (context hook) | `<session>/<message>` (OpenCode message id, no `#`) | `ses_abc/msg_xyz` |
| `wire …` (http.request hook) | `<session>/wire` — **session scope only** | `ses_abc/wire` |
| `response …` (http.response hook) | `<session>/<message>#<attempt>` | `ses_abc/msg_xyz#2` |

**Why the wire line is coarse:** `SessionHttpRequest` carries no message id
(`session.d.ts:65-71`), so it can only be attributed to the session, not the turn.
Join at session granularity: count `wire tools=…` occurrences per session and
compare against the `request`/`response` turns in that session. It is a
per-session sanity check that the tools array leaves OpenCode populated, **not** a
per-turn exact match.

Join `request` (tools) → `response` (outcome) per turn, stripping `#k` off the
response label:

```sh
grep -E '\b(request|response)\b' /tmp/opencode/dsml-plugin.log \
  | sed -E 's/^[^ ]+ \[dsml\] //' \
  | awk '/^request/{t=$2; tc[t]=$3; next} /^response/{split($2,a,"#"); print tc[a[1]], $3}' \
  | sort | uniq -c | sort -rn
```

Output columns: `<count> tools=N <outcome>`. Outcome values:
`passthrough`, `recovered=K`, `redacted-no-call`, `held-candidate-no-call`.

Then check the wire probe per session:

```sh
grep 'wire ' /tmp/opencode/dsml-plugin.log \
  | sed -E 's/^[^ ]+ \[dsml\] //' \
  | awk '{print $2, $3, $4}' | sort | uniq -c | sort -rn
```

Output: `<count> <session>/wire tools=N names=[…]`. If every `wire` line for a
session shows `tools>0`, the tools array survived assembly for that session — so
any leak there is downstream of OpenCode (5c row 1).

### 5c. What to look for

| Observation | Interpretation |
| :--- | :--- |
| Leaks (`recovered=K` / `redacted-no-call` / `held-candidate-no-call`) on `tools>0` turns | Contradicts the responder's `tools=0` correlation **for our path**. Expected, since captures show named recovered calls (`get_weather`). |
| Leaks concentrated on `tools=0` turns | Consistent with their correlation — but check 5d before believing it. |
| A session that clearly uses tools shows `tools=0` on a leaking turn | **Real finding:** something upstream (OpenCode native route, or the provider) is stripping the tools array. The most interesting outcome. |
| A session's turns are mostly `tools=0` | Check whether that session ever uses tools at all; if not, the count is just "no tools this turn," not a signal. |

### 5d. Rule out the artifact

`tools=0` is only meaningful against a session that otherwise has `tools>0`.
Scan one session's tool-count distribution:

```sh
grep 'request ' /tmp/opencode/dsml-plugin.log \
  | grep -oE 'tools=[0-9]+' | sort | uniq -c | sort -rn
```

If a session that visibly invokes tools still logs `tools=0` broadly, the count
is being lost somewhere and a `tools=0` correlation would be an artifact.

### 5e. Cross-check with the capture log (byte-level)

`/tmp/opencode/dsml-capture.log` (NDJSON) records the response-side decisions but
has **no tools field**; its schema is `ts, ev, src, branch, buf, bufferLen, cap,
closed, deltaLen, final, hasBlockOpen, holdStart, insideValue, len, names,
originalLen, overCap, overEager, ranges, reason, recoveredCalls, text`. It is the
source for the *shape* of a leak (e.g. `emit-resolved` with `names:[...]`), which
5b's outcome counts summarize.

## 6. What to report back

For our own issue thread / the reply, the honest line once data exists:
- State whether our path uses a conversion layer (it does not; OpenCode → DeepInfra direct).
- Report the `tools=N → outcome` distribution for the long session.
- Report whether any leaking turn had `tools=0` **and** came from an otherwise
  tool-using session (the only version of the finding that means something).
- Keep the caveat: our result does not address the responder's setup.

## 7. Rollback

```sh
cp ~/.config/opencode/opencode.jsonc.bak.20261018_100347 ~/.config/opencode/opencode.jsonc
# then restart OpenCode / start a new session
```
