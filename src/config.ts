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
     * The argument KEY is not in the bytes, so recovery needs a schema-derived
     * key from `bareValueKeys`; a tool not in that map is NOT recovered (it falls
     * through to redaction). See `bareValueKeys`.
     */
    bareValueTool?: boolean
    /**
     * Tool-name → argument-key map for the bare-value rescue (V27). A tool is
     * only recovered when it appears here, because the leaked bytes carry the
     * value but not its key, and a wrong key is worse than a redaction.
     *
     * Defaults to the OpenCode tools with exactly ONE required string argument
     * (`shell`→`command`, `websearch`→`query`). Extend it for custom agents; set
     * a tool to `null` to explicitly exclude it.
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

/** Whether this model/provider pair is in scope. Matches provider ID exactly. */
export function appliesToProvider(config: ResolvedDsmlConfig, providerID: string | undefined): boolean {
  if (!providerID) return false
  return config.providers.includes(providerID)
}
