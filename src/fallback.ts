/**
 * Retry safety net for turns the live fix could not recover. Pure decision logic
 * lives here so it is unit-testable; OpenCode I/O (events, session reads,
 * synthetic prompts, storage) is injected by `src/index.ts`.
 *
 * Policy: when a session goes idle and its latest assistant text holds DSML markup
 * that never became a tool call, send one short correction nudge (see
 * `src/prompt.ts`). Send-once per message: a message that stays silent after one
 * wake is left alone, never re-poked — if the first poke got no reply the cause
 * is outside anything a second poke can fix.
 */

import { looksLikeDsml } from "./grammar.ts"
import { parseDsml, type ParseOptions } from "./parse.ts"
import { loopNudge, recoveryNudge } from "./prompt.ts"

export interface FallbackDecision {
  /** Whether to send the nudge. */
  readonly send: boolean
  /** The nudge text, present when `send` is true. */
  readonly text?: string
  /** Storage key the send was (or would be) recorded under. */
  readonly key?: string
  /** Why no nudge is sent. */
  readonly reason?: string
}

/** Storage key for the attempt counter of one assistant message. */
export function attemptKey(sessionID: string, messageID: string): string {
  return `dsml/resume/${sessionID}/${messageID}`
}

/**
 * Minimal wake ping for the `"system"` resume channel. The substantive correction
 * rides as a transient system instruction (see `needsSystemNudge`); this message
 * only exists to wake the session so a new turn happens. Kept short and factual
 * so the user-channel transcript stays clean.
 */
export function wakeText(): string {
  return "Resume the interrupted tool call."
}

export interface HookMessage {
  readonly id?: string
  readonly role?: string
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: unknown }>
}

export interface SystemNudge {
  /** Dedupe key: message id when present, otherwise a hash of the text. */
  readonly key: string
  /** The correction text for the system channel. */
  readonly text: string
}

/** Stable dedupe key for a hook message: id when present, content hash otherwise. */
export function nudgeCapKey(message: HookMessage): string {
  if (message.id) return message.id
  return contentHash(message)
}

function contentHash(message: HookMessage): string {
  let hash = 0
  for (const part of message.content ?? []) {
    const text = part.type === "text" && typeof part.text === "string" ? part.text : ""
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `hash-${(hash >>> 0).toString(36)}`
}

/**
 * Identify the current user turn from assembled history: the id of the last
 * user-role message, falling back to a content hash when ids are absent. This
 * is OpenCode's own message identity (`SessionMessage.ID`), so turns line up
 * with what the transcript, inbox, and logs already use. Retries within one
 * turn share the turn id — attempts are counted separately by the caller.
 */
export function turnId(messages: ReadonlyArray<HookMessage>): string {
  const last = [...messages].reverse().find((message) => message.role === "user")
  if (!last) return "no-user-turn"
  return last.id ?? contentHash(last)
}

/**
 * Decide whether the assembled request history ends in unrecovered DSML and needs
 * the correction as a transient system instruction. Pure: the caller enforces the
 * send-once rule via storage. Returns undefined when no nudge is warranted.
 */
export function needsSystemNudge(
  messages: ReadonlyArray<HookMessage>,
  parseOptions?: ParseOptions,
): SystemNudge | undefined {
  const last = [...messages].reverse().find((message) => message.role === "assistant")
  if (!last) return undefined
  const text = messageText({ role: last.role, content: last.content })
  if (!text || !looksLikeDsml(text)) return undefined
  const { calls } = parseDsml(text, parseOptions)
  if (calls.length > 0) return undefined
  return { key: nudgeCapKey(last), text: recoveryNudge() }
}

/**
 * Decide whether the latest assistant text warrants a correction nudge.
 * Send-once per message: `alreadySent` means this message was already poked
 * once and stayed silent — leave it alone.
 *
 * @param text the latest assistant text
 * @param alreadySent whether a nudge/wake was already sent for this message
 * @param redactionSeen whether the live fix redacted unrecoverable markup this
 *   turn (the marker is then gone from the stored text, §22)
 * @param loopSeen whether the live fix flagged this turn as a degenerate
 *   repetition loop. Fires with or without a marker: the loop is a stall on
 *   its own. The nudge text differs — a loop must be broken by demanding one
 *   concrete action, not by re-explaining the markup grammar.
 */
export function decideResume(
  text: string,
  alreadySent: boolean,
  redactionSeen = false,
  loopSeen = false,
): FallbackDecision {
  const marker = looksLikeDsml(text)
  // Recoverable markup needs no wake at all: the turn did not stall.
  if (marker && parseDsml(text).calls.length > 0) {
    return { send: false, reason: "already-recoverable" }
  }
  // `redactionSeen`: this session's live fix REDACTED markup it could not
  // recover, which erased the marker from the stored text — the wake is still
  // warranted (§22). `loopSeen`: the turn degenerated into repeated filler,
  // marker or not — same conclusion.
  if (!marker && !redactionSeen && !loopSeen) return { send: false, reason: "no-marker" }
  if (alreadySent) return { send: false, reason: "already-sent" }
  // Which correction to send: when a marker (or a redaction that erased one) is
  // in play the stall was markup, so the grammar fixer applies. Only a PURE
  // loop — no markup anywhere — gets the action-demand wake.
  const pureLoop = !marker && !redactionSeen && loopSeen
  return { send: true, text: pureLoop ? loopNudge() : recoveryNudge() }
}

/** Extract readable text from an OpenCode session-context message. */
export function messageText(message: {
  readonly role?: string
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: unknown }>
}): string | undefined {
  if (message.role && message.role !== "assistant") return undefined
  const parts = (message.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string")
  if (parts.length === 0) return undefined
  return parts.map((part) => part.text as string).join("\n")
}

/** Read a send-once flag from storage. Any truthy value means already sent. */
export function alreadySent(value: unknown): boolean {
  return value === true || value === 1 || value === "1"
}
