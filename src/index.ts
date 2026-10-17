/**
 * opencode-plugin-dsml-fix — recover DeepSeek DSML tool calls that leak as text.
 *
 * Four features (see README), each independently configurable:
 * - `parse`: tolerant parser — complete blocks plus orphan invokes, loose
 *   parameters, raw-JSON bodies, wrapped tools. Same flags govern live
 *   recovery and history stain detection.
 * - `history`: strip leaked spans from replayed assistant text (+ note).
 *   Never synthesizes calls from history (no double execution).
 * - `responseFix`: turn leaked markup into real calls on the live response,
 *   native SSE path and AI-SDK path alike.
 * - `retry`: conditional correction nudge plus one idle wake per message.
 *
 * Invariant: the plugin must never break normal inference. Unknown shapes pass
 * through untouched, and every layer degrades to a safer subset via config.
 */

import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import {
  appliesToProvider,
  bareValueKeyResolver,
  mergeBareValueKeys,
  resolveConfig,
  type DsmlPluginOptions,
} from "./config.ts"
import {
  alreadySent,
  attemptKey,
  decideResume,
  messageText,
  needsSystemNudge,
  turnId,
  wakeText,
} from "./fallback.ts"
import { createDsmlStreamMiddleware, wrapDsmlLanguageModel } from "./middleware.ts"
import { parseDsml, redactionNote, stripRangesWithNote, type ParseOptions } from "./parse.ts"
import { rewriteSseResponse } from "./sse.ts"

const PLUGIN_ID = "dsml"

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    try {
      appendFileSync(
        "/tmp/opencode/dsml-plugin.log",
        `${new Date().toISOString()} [dsml] setup enter dir=${ctx.location.directory}\n`,
      )
    } catch {
      // best effort
    }
    const config = resolveConfig((ctx.options ?? {}) as DsmlPluginOptions)
    if (config.providers.length === 0) return

    const log = (...args: unknown[]) => {
      if (!config.debug) return
      const line = `[${PLUGIN_ID}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`
      console.error(line.trimEnd())
      try {
        appendFileSync("/tmp/opencode/dsml-plugin.log", `${new Date().toISOString()} ${line}`)
      } catch {
        // best effort
      }
    }
    const parseOptions: ParseOptions = {
      orphanInvoke: config.orphanInvoke,
      looseParameters: config.looseParameters,
      rawJsonBody: config.rawJsonBody,
      wrappedTool: config.wrappedTool,
      bareValueTool: config.bareValueTool,
      resolveBareValueKey: bareValueKeyResolver(config),
    }
    // Tool-name → argument-key map per session, derived from the live tool
    // schemas seen on the `context` hook (which runs before the response hooks).
    // The response hooks have no access to the tool list, so the schema-aware
    // keys are stashed here and looked up by session id (§22 V27, schema-aware).
    const sessionBareValueKeys = new Map<string, Record<string, string>>()

    /** Parse options with the session's schema-derived bare-value keys merged in. */
    const parseOptionsFor = (sessionID: string | undefined): ParseOptions => {
      const keys = sessionID ? sessionBareValueKeys.get(sessionID) : undefined
      if (!keys || Object.keys(keys).length === 0) return parseOptions
      return { ...parseOptions, resolveBareValueKey: (toolName: string) => keys[toolName] }
    }
    // Active turn per session: OpenCode's own user-message id, captured on the
    // request and reused by the response so both log lines carry the same
    // `session/message` identity. Attempts count physical requests within a turn.
    const turns = new Map<string, { turn: string; attempts: number }>()

    // Sessions whose most recent primary response redacted leaked markup it
    // could not recover. The retry safety net must fire for these even though the
    // stored transcript no longer contains a DSML marker (redaction erases it).
    const redactedSessions = new Set<string>()

    // --- Live response fix: model recovery ------------------------------------
    if (config.responseFixEnabled) {
      await ctx.aisdk.hook("language", (event) => {
        try {
          appendFileSync(
            "/tmp/opencode/dsml-plugin.log",
            `${new Date().toISOString()} [dsml] language hook provider=${event.model.providerID} id=${event.model.id} hasLanguage=${!!event.language} hasSdk=${!!event.sdk}\n`,
          )
        } catch {
          // best effort
        }
        if (!appliesToProvider(config, event.model.providerID)) return
        // Hooks run before the default construction, so `language` is usually
        // still unset. Wrap the default model when the SDK exposes a constructor;
        // otherwise wrap whatever a previous hook installed. If neither exists,
        // pass through — the plugin must never break inference.
        const constructed =
          typeof event.sdk?.languageModel === "function"
            ? event.sdk.languageModel(event.model.modelID ?? event.model.id)
            : undefined
        const base = event.language ?? constructed
        if (!base) {
          log("no language model to wrap for", event.model.providerID, event.model.id)
          return
        }
        // NB: this AI-SDK hook carries no session id, so the schema-derived keys
        // cached by the `context` hook cannot be applied here. That is fine for
        // the catalog route the leak appears on (native SSE, handled below); this
        // path keeps the static config keys only.
        event.language = wrapDsmlLanguageModel(base, {
          ...parseOptions,
          stream: true,
          generate: true,
          bufferLimit: config.bufferLimit,
          capture: config.capture,
          onSettled: (stats) => {
            const what =
              stats.calls > 0
                ? `recovered=${stats.calls}`
                : stats.redacted
                  ? "redacted-no-call"
                  : stats.sawCandidate
                    ? "held-candidate-no-call"
                    : "passthrough"
            log(`response model=${event.model.providerID}/${event.model.id} ${what}`)
          },
        })
        log("wrapped language model for", event.model.providerID, event.model.id)
      })
    }

    // --- Live response fix: SSE rewrite on the native protocol path ------------
    // Catalog providers such as opencode-go resolve to the NATIVE
    // openai-compatible route, where `aisdk.language` never fires. The native
    // route offers every request to the http hooks, so rewrite the SSE bytes
    // there instead. Same parser, same policy, different wire format.
    if (config.responseFixEnabled) {
      await ctx.session.hook("http.response", (event) => {
        if (!appliesToProvider(config, event.model.providerID)) return
        if (event.kind !== "primary") return
        const sessionID = event.sessionID
        const slot = turns.get(sessionID) ?? { turn: "unknown-turn", attempts: 0 }
        slot.attempts += 1
        turns.set(sessionID, slot)
        const label = `${sessionID}/${slot.turn}#${slot.attempts}`
        try {
          event.response = rewriteSseResponse(event.response, {
            ...parseOptionsFor(sessionID),
            bufferLimit: config.bufferLimit,
            capture: config.capture,
            onSettled: (stats) => {
              // Remember a redaction so the idle wake still fires for this
              // session despite the marker having been erased from the text.
              if (stats.redacted) redactedSessions.add(sessionID)
              const what =
                stats.calls > 0
                  ? `recovered=${stats.calls}`
                  : stats.redacted
                    ? "redacted-no-call"
                    : stats.sawCandidate
                      ? "held-candidate-no-call"
                      : "passthrough"
              log(`response ${label} ${what}`)
            },
          })
        } catch (error) {
          log("sse rewrite skipped:", error instanceof Error ? error.message : String(error))
        }
      })
    }

    // --- Request shaping: sanitize + conditional nudge -------------------------
    await ctx.session.hook("context", async (event) => {
      if (!appliesToProvider(config, event.model.providerID)) return
      // Cache the schema-derived bare-value keys for this session so the
      // response hooks (which lack the tool list) can recover a bare leaked
      // value (§22 V27). `context` runs before the response — verified against a
      // live turn. Static config keys still apply as a fallback.
      if (config.bareValueTool) {
        const merged = mergeBareValueKeys(config, event.tools)
        sessionBareValueKeys.set(event.sessionID, merged)
      }
      // A new user message starts a new turn: reset the attempt counter so the
      // response lines for this turn share one `session/message` identity.
      const turn = turnId(event.messages)
      const seen = turns.get(event.sessionID)
      if (!seen || seen.turn !== turn) turns.set(event.sessionID, { turn, attempts: 0 })
      const label = `${event.sessionID}/${turn}`
      let sanitizedMsgs = 0
      let sanitizedParts = 0
      let nudge = false
      if (config.sanitizeEnabled) {
        // Strip leaked DSML spans from replayed assistant text so the model does
        // not imitate its own degraded output. A short inline note marks each
        // redaction so the transcript records that something was tried and
        // dropped, without keeping the broken markup as a bad example. Never
        // synthesize calls here: history calls already ran (or never will), and
        // appending would double-execute.
        for (const message of event.messages) {
          if (message.role !== "assistant" || !Array.isArray(message.content)) continue
          let touched = false
          for (const part of message.content) {
            if (typeof part !== "object" || part === null) continue
            const text = (part as { type?: unknown; text?: unknown }).text
            if ((part as { type?: unknown }).type !== "text" || typeof text !== "string") continue
            const { calls, ranges } = parseDsml(text, parseOptions)
            if (ranges.length === 0) continue
            ;(part as { text: string }).text = stripRangesWithNote(
              text,
              ranges,
              redactionNote(calls.map((call) => call.name)),
            )
            touched = true
            sanitizedParts++
          }
          if (touched) sanitizedMsgs++
        }
      }
      if (config.retryNudgeEnabled) {
        const need = needsSystemNudge(event.messages, parseOptions)
        if (need) {
          const key = attemptKey(event.sessionID, need.key)
          if (alreadySent(await ctx.storage.get(key))) {
            log("nudge already sent for", need.key)
          } else {
            await ctx.storage.set(key, true)
            event.system.push({ type: "text", text: need.text })
            nudge = true
          }
        }
      }
      // One line per request turn: what each request layer actually did.
      if (sanitizedMsgs > 0 || nudge) {
        log(
          `request ${label} sanitized=${sanitizedMsgs}msgs/${sanitizedParts}parts nudge=${nudge ? "yes" : "no"}`,
        )
      }
    })

    // --- Retry: one wake per stalled step ---------------------------------------
    // The wake must fire when a turn ends WITHOUT a tool call after the live fix
    // redacted leaked markup. The V2 runtime does NOT emit `session.idle` /
    // `session.status` to plugins (verified 2026-10-17 against a live turn: the
    // only terminal event is `session.step.ended`). That event carries the
    // payload the wake needs:
    //   { type: "session.step.ended", data: { sessionID, finish, assistantMessageID } }
    // `finish === "stop"` means the step ended with no tool call — the stall.
    // The session id lives at `data.sessionID` (NOT `event.sessionID`).
    if (!config.retryEnabled) return
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const stalled = stalledStepSession(raw)
          if (!stalled) continue
          const { sessionID, legacyIdle } = stalled
          // Fast path: a stalled step only matters if the live fix redacted
          // markup for this session (the marker is gone from the stored text, so
          // no other signal survives). Avoids a context() read on every normal
          // turn. A marker-bearing transcript is still caught by the context
          // hook's nudge, so this does not lose coverage.
          if (!redactedSessions.has(sessionID) && !legacyIdle) continue
          await maybeWake(ctx, config, log, sessionID, redactedSessions).catch((error) =>
            log("wake failed", error),
          )
        }
      } catch {
        // Aborted on unload.
      }
    })()
    return () => controller.abort()
  },
})

type Ctx = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
type Config = ReturnType<typeof resolveConfig>

/**
 * Interpret a plugin event as a "stalled step" signal.
 *
 * The V2 runtime emits `session.step.ended` with `data.finish`; a `finish` of
 * `"stop"` means the turn ended with no tool call (the stall condition). The
 * session id is at `data.sessionID` — NOT `event.sessionID` (verified live
 * 2026-10-17; `session.idle`/`session.status` are never delivered to plugins).
 *
 * Returns the session id when the event is a terminal stalled step, else
 * `undefined`. Legacy idle events (if ever emitted) also qualify.
 */
export function stalledStepSession(raw: unknown): { sessionID: string; legacyIdle: boolean } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const evt = raw as { type?: unknown; data?: Record<string, unknown>; sessionID?: unknown; status?: { type?: unknown } }
  const type = evt.type
  const legacyIdle = type === "session.idle" || (type === "session.status" && evt.status?.type === "idle")
  if (type !== "session.step.ended" && !legacyIdle) return undefined
  const sessionID =
    typeof evt.data?.sessionID === "string"
      ? evt.data.sessionID
      : typeof evt.sessionID === "string"
        ? evt.sessionID
        : undefined
  if (!sessionID) return undefined
  if (!legacyIdle && evt.data?.finish !== undefined && evt.data.finish !== "stop") return undefined
  return { sessionID, legacyIdle }
}

async function maybeWake(
  ctx: Ctx,
  config: Config,
  log: (...args: unknown[]) => void,
  sessionID: string,
  redactedSessions: Set<string>,
): Promise<void> {
  const messages = await ctx.session.context({ sessionID })
  const last = [...messages].reverse().find((message) => message.type === "assistant")
  if (!last || last.type !== "assistant") return
  const text = messageText({
    role: last.type,
    content: last.content as ReadonlyArray<{ readonly type?: string; readonly text?: string }>,
  })
  if (!text) return
  const key = attemptKey(sessionID, last.id)
  const sent = alreadySent(await ctx.storage.get(key))
  const redactionSeen = redactedSessions.has(sessionID)
  const decision = decideResume(text, sent, redactionSeen)
  if (!decision.send || !decision.text) {
    if (decision.reason && decision.reason !== "no-marker") log(decision.reason, "for", last.id)
    return
  }
  // Clear the flag once consumed so a later unrelated idle does not re-wake.
  redactedSessions.delete(sessionID)
  await ctx.storage.set(key, true)
  if (config.retryChannel === "user") {
    // The full correction travels as a synthetic user turn.
    await ctx.session.synthetic({ sessionID, text: decision.text })
  } else {
    // System channel: minimal wake ping; the context hook attaches the full
    // correction as a transient system instruction on the woken turn.
    await ctx.session.synthetic({ sessionID, text: wakeText(), description: "dsml-retry wake" })
  }
  log("sent wake for", last.id, `channel=${config.retryChannel}`)
}

export { createDsmlStreamMiddleware }