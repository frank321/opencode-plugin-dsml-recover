---
name: Bug report
about: Something misbehaved — recovery failed, a good turn was corrupted, or the plugin errored
title: ""
labels: bug
assignees: ""
---

<!--
Before filing: this plugin is tested only on DeepSeek V4.1 via the DeepInfra
provider, on OpenCode V2. Issues about other providers/models are welcome, but
I may not be able to reproduce them. See the README "Scope & tested
configuration".

Hygiene: do NOT paste a raw DSML token directly into this issue if your client
might act on it. Wrap any leaked markup in a fenced code block and, if in doubt,
replace the marker bar with the text `<DSML>` or `‹DSML›`. A screenshot of the
leaked text is always safe.
-->

## What happened

<!-- One or two sentences. Did a tool call leak? Did a good turn get corrupted? Did the plugin throw? -->

## Expected

<!-- What should have happened instead. -->

## Environment

- **OpenCode version:** <!-- e.g. 2.0.27 (run `opencode --version`) -->
- **Provider:** <!-- e.g. deepinfra, opencode-go, ... -->
- **Model:** <!-- e.g. deepseek-v4.1-flash -->
- **Plugin version:** <!-- e.g. 1.0.0 -->
- **Config options changed:** <!-- paste the relevant `options` block, or "defaults" -->

## The leak / markup (redacted if needed)

<!--
Paste the offending assistant text inside a fenced block. Redact the marker bar
to `<DSML>` if you prefer. Include ~200 chars before and after so I can see the
degraded shape. If you have `"debug": true` output, include the `[dsml]` lines.
-->

```
<DSML>parameter name="shell">…</DSML>parameter>
</invoke>
</DSML calls>
```

## How reproducible

<!-- Every time / intermittent / once. Approximate context size if known (the leak
tends to hit late in long sessions). -->
