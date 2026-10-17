/**
 * Plugin configuration. Every behaviour the plugin adds can be narrowed back to a
 * simpler version without uninstalling: if one shape misfires, switch its flag off
 * and the plugin degrades to a safer subset. The invariant is that the plugin
 * must never break normal inference — when in doubt it passes traffic through.
 *
 * Namespaces match the four features in the README: `parse`, `history`,
 * `responseFix`, `retry`. Top level holds only general settings.
 */

export interface DsmlPluginOptions {
  /**
   * Provider IDs this plugin applies to. Defaults to the two Zen endpoints where
   * the DSML leak was observed. An empty list disables the plugin entirely.
   */
  providers?: string[]
  /**
   * Parser tolerance. Each flag defaults to true; switch one off in isolation
   * when that shape misfires. The same flags govern live recovery and what
   * counts as a stain in history (one engine, both directions).
   */
  parse?: {
    /** Recover `invoke` blocks with no outer opener. Default true. */
    orphanInvoke?: boolean
    /** Tolerant re-scan when a value ran past a broken closer. Default true. */
    looseParameters?: boolean
    /** Bare-`{…}` invoke body parsed as JSON. Default true. */
    rawJsonBody?: boolean
    /** Orphan `<parameter name="X">` with complete inner params. Default true. */
    wrappedTool?: boolean
    /**
     * Recover a bare-value orphan parameter (V27, §22 real leak):
     * `<parameter name="X">VALUE</parameter>` with no inner params, followed by
     * an orphan invoke/block closer. Default true.
     *
     * The argument KEY is not in the bytes, so recovery needs a key derived from
     * the session's live tool schema (any tool whose input has exactly one
     * required string arg — `shell`→`command`, `read`→`filePath`). Absent a
     * derivable key the tool is NOT recovered (it falls through to redaction).
     * `bareValueKeys` is a static fallback for schemas the walker cannot read.
     */
    bareValueTool?: boolean
    /**
     * Static tool-name → argument-key fallback for the bare-value rescue (V27).
     * The primary source is the live tool schema seen on the `context` hook;
     * this map is merged UNDER it, so it only fills gaps (custom agents, tools
     * whose schema the walker cannot parse). A wrong key is worse than a
     * redaction (§3.D).
     *
     * Defaults to the known single-required-string OpenCode tools
     * (`shell`→`command`, `websearch`→`query`).
     */
    bareValueKeys?: Record<string, string>
  }
  /** History sanitization: strip leaked spans from replayed assistant text. */
  history?: {
    /** Default true. Leave on: disabling re-poisons the transcript. */
    sanitize?: boolean
  }
  /** Live response fix: turn leaked markup into real tool calls. */
  responseFix?: {
    /** Master switch for all transports. Default true. */
    enabled?: boolean
    /** Streaming hold cap in bytes. Safety bound, not a target. Default 65536. */
    bufferLimit?: number
  }
  /** Retry safety net for turns the fix could not recover. */
  retry?: {
    /**
     * Master switch for the idle wake. Default true.
     * Send-once per message: a message that stays silent after one
     * wake is left alone, never re-poked.
     */
    enabled?: boolean
    /**
     * Conditional correction nudge when history ends in unrecovered markup.
     * Default true.
     */
    nudge?: boolean
    /**
     * Delivery channel for the wake.
     * - `"system"` (default): minimal wake ping; the correction rides as a
     *   transient system instruction via the context hook.
     * - `"user"`: full correction as a synthetic user turn.
     */
    channel?: "system" | "user"
  }
  /** Log recoveries to stderr. Default false. Off-by-default. */
  debug?: boolean
  /**
   * LOCAL FORK DIAGNOSTIC: capture the leaked BYTES and buffer sizes of every
   * DSML candidate to `/tmp/opencode/dsml-capture.log` (NDJSON). Unlike `debug`
   * (per-turn summaries only), this records the `drain()` decision, the exact
   * buffer length, and the over-cap path — enough to tell whether the long-
   * context failure is a too-small `bufferLimit` or a malformed shape.
   * Observer only: never changes what is emitted. Default false.
   */
  capture?: boolean
}

export interface ResolvedDsmlConfig {
  readonly providers: readonly string[]
  readonly orphanInvoke: boolean
  readonly looseParameters: boolean
  readonly rawJsonBody: boolean
  readonly wrappedTool: boolean
  readonly bareValueTool: boolean
  readonly bareValueKeys: Readonly<Record<string, string>>
  readonly bufferLimit: number
  readonly responseFixEnabled: boolean
  readonly sanitizeEnabled: boolean
  readonly retryEnabled: boolean
  readonly retryNudgeEnabled: boolean
  readonly retryChannel: "system" | "user"
  readonly debug: boolean
  readonly capture: boolean
}

const DEFAULT_PROVIDERS = ["opencode-go", "opencode"] as const

/**
 * OpenCode tools whose schema has exactly ONE required string argument, so a
 * bare leaked value can be bound to a key without guessing. Verified against
 * `packages/core/src/tool/plugin/*.ts` (2026-10-17): these are the only built-in
 * tools where the key is unambiguous (`edit` needs 3 args, `write`/`subagent`
 * need several, `read`/`glob`/`grep`/`skill` require none → all excluded).
 * Extend via `parse.bareValueKeys` for custom agents; the map is additive.
 */
const DEFAULT_BARE_VALUE_KEYS: Readonly<Record<string, string>> = {
  shell: "command",
  websearch: "query",
}

export function resolveConfig(input: DsmlPluginOptions = {}): ResolvedDsmlConfig {
  const parse = input.parse ?? {}
  const history = input.history ?? {}
  const responseFix = input.responseFix ?? {}
  const retry = input.retry ?? {}
  return {
    providers: input.providers ?? [...DEFAULT_PROVIDERS],
    orphanInvoke: parse.orphanInvoke ?? true,
    looseParameters: parse.looseParameters ?? true,
    rawJsonBody: parse.rawJsonBody ?? true,
    wrappedTool: parse.wrappedTool ?? true,
    bareValueTool: parse.bareValueTool ?? true,
    bareValueKeys: { ...DEFAULT_BARE_VALUE_KEYS, ...(parse.bareValueKeys ?? {}) },
    bufferLimit: responseFix.bufferLimit ?? 64 * 1024,
    responseFixEnabled: responseFix.enabled ?? true,
    sanitizeEnabled: history.sanitize ?? true,
    retryEnabled: retry.enabled ?? true,
    retryNudgeEnabled: retry.nudge ?? true,
    retryChannel: retry.channel ?? "system",
    debug: input.debug ?? false,
    capture: input.capture ?? false,
  }
}

/** Build the V27 key resolver from the resolved config. tools absent → decline. */
export function bareValueKeyResolver(config: ResolvedDsmlConfig): (toolName: string) => string | undefined {
  return (toolName: string) => config.bareValueKeys[toolName]
}

/** Minimal JSON-Schema shape needed to read a tool's input schema. */
interface JsonSchemaLike {
  readonly type?: unknown
  readonly properties?: Record<string, JsonSchemaLike>
  readonly required?: readonly unknown[]
}

/**
 * Derive the tool-name → argument-key map from the session's live tool schemas
 * (`SessionContext.tools`), replacing the static `bareValueKeys` allowlist.
 *
 * A tool qualifies ONLY when its input schema is a plain object with exactly one
 * required property, and that property is a string. Then a bare leaked value has
 * exactly one place to go, so binding it is not a guess: `shell`→`command`,
 * `read`→`filePath`, `websearch`→`query`. Every other shape declines — a wrong
 * key is worse than a redaction (§3.D). The static config map is merged in as a
 * fallback so custom agents with unusual schemas can still be listed by hand;
 * an explicit `null` in config would be a future exclusion (not yet supported).
 */
export function schemaBareValueKeys(
  tools: Record<string, { readonly input?: JsonSchemaLike }> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!tools) return out
  for (const [toolName, tool] of Object.entries(tools)) {
    const schema = tool?.input
    if (!schema || schema.type !== "object") continue
    const required = Array.isArray(schema.required) ? schema.required : []
    if (required.length !== 1) continue
    const key = required[0]
    if (typeof key !== "string") continue
    const prop = schema.properties?.[key]
    if (!prop || prop.type !== "string") continue
    out[toolName] = key
  }
  return out
}

/** Merge the live schema-derived keys over the static config fallback. */
export function mergeBareValueKeys(
  config: ResolvedDsmlConfig,
  tools: Record<string, { readonly input?: JsonSchemaLike }> | undefined,
): Record<string, string> {
  return { ...config.bareValueKeys, ...schemaBareValueKeys(tools) }
}

/** Whether this model/provider pair is in scope. Matches provider ID exactly. */
export function appliesToProvider(config: ResolvedDsmlConfig, providerID: string | undefined): boolean {
  if (!providerID) return false
  return config.providers.includes(providerID)
}
