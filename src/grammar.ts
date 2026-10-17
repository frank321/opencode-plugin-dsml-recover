/**
 * DSML marker grammar — the single source of truth for every regex in this plugin.
 *
 * See `docs/PATTERNS.md` for the catalogue of variants this grammar accepts. Every
 * regex here traces to a numbered row (V1–V25, reject arms) and has a matching test
 * in `test/` (see `docs/TEST-MATRIX.md`).
 *
 * The canonical DeepSeek grammar uses single full-width bars:
 *
 *   <BAR DSML BAR tool_calls>
 *   <BAR DSML BAR invoke name="bash">
 *   <BAR DSML BAR parameter name="command" string="true">ls</BAR DSML BAR parameter>
 *   </BAR DSML BAR invoke>
 *   </BAR DSML BAR tool_calls>
 *
 * Gateways that re-decode special tokens emit mangled variants instead: bars double
 * up, a space appears where `tool_` was, the block tag is left as a bare `calls`, or
 * the outer opener disappears entirely. One marker fragment has to swallow all of
 * them without ever matching ordinary prose.
 */

/** U+FF5C full-width vertical bar, or an ASCII pipe. */
const BAR = "[\\uFF5C|]"

/**
 * A DSML marker: one or two bars, the word DSML, one or two bars, optional
 * whitespace. Accepts `｜DSML｜`, `｜｜DSML｜｜`, `|DSML|`, and the spaced
 * mangled form. (V2, V3, V4)
 */
export const MARKER = `(?:${BAR}{1,2}\\s*DSML\\s*${BAR}{1,2}\\s*)`

/** Outer block tag names. `calls` is the mangled truncation of `tool_calls`. (V5, V7, V8) */
export const BLOCK_TAG = "(?:tool_calls|function_calls|tool_call|calls)"

/** Every tag name that carries a marker, for dangling-marker cleanup. */
const ANY_TAG = "(?:tool_calls|function_calls|tool_call|calls|invoke|parameter)"

/** `<MARKERtool_calls …>` and friends. */
export const blockOpenRe = (): RegExp => new RegExp(`<${MARKER}${BLOCK_TAG}\\s*>`, "giu")

/** `</MARKERtool_calls>` and friends, tolerant of an omitted closing marker. (V11) */
export const blockCloseRe = (): RegExp => new RegExp(`</${MARKER}${BLOCK_TAG}\\s*>`, "giu")

/** `<MARKERinvoke name="x">` with flexible spacing and quote style. (V6) */
export const invokeOpenRe = (): RegExp =>
  new RegExp(`<${MARKER}invoke\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?\\s*>`, "giu")

/** `</MARKERinvoke>`. */
export const invokeCloseRe = (): RegExp => new RegExp(`</${MARKER}invoke\\s*>`, "giu")

/** `<MARKERparameter name="k" string="true">value</MARKERparameter>`. (V22, V23, V24) */
export const parameterRe = (): RegExp =>
  new RegExp(
    `<${MARKER}parameter\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?` +
      `(?:\\s+string\\s*=\\s*["']?(true|false)["']?)?\\s*>` +
      `([\\s\\S]*?)</${MARKER}parameter\\s*>`,
    "giu",
  )

/**
 * Tolerant parameter scan used only as a *fallback* when a well-formed
 * `parameterRe` value ran away into the next parameter. This is the vLLM #54686
 * 49% leak: a mis-spelled closer `</BAR DSML BAR>` (bar then `>`) makes the strict
 * regex consume the whole next parameter. Here each open tag captures until the
 * next parameter open, any invoke/block close, a malformed closer, or end. (V11)
 */
export const parameterLooseRe = (): RegExp =>
  new RegExp(
    `<${MARKER}parameter\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?` +
      `(?:\\s+string\\s*=\\s*["']?(true|false)["']?)?\\s*>` +
      `([\\s\\S]*?)` +
      `(?=</${MARKER}(?:parameter|invoke|${BLOCK_TAG})\\b` +
      `|<${MARKER}parameter\\b` +
      `|</${MARKER}>` +
      `|$)`,
    "giu",
  )

/**
 * A single orphan parameter element (no enclosing invoke), captured with its body
 * and either a proper or malformed closer, so the leaked value is removed too. (V10)
 */
export const orphanParameterRe = (): RegExp =>
  new RegExp(
    `<${MARKER}parameter\\b[^>]*>` +
      `([\\s\\S]*?)` +
      `(?=</${MARKER}(?:parameter|invoke|${BLOCK_TAG})\\b` +
      `|<${MARKER}parameter\\b` +
      `|</${MARKER}>` +
      `|$)`,
    "giu",
  )

/** An orphan `invoke` with no block, captured with its body. (V9) */
export const orphanInvokeRe = (): RegExp =>
  new RegExp(
    `<${MARKER}invoke\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?\\s*>` +
      `([\\s\\S]*?)` +
      `(?=</${MARKER}invoke\\b|<${MARKER}invoke\\b|</${MARKER}${BLOCK_TAG}\\s*>|$)`,
    "giu",
  )

/**
 * A wrapped tool call (V26): an orphan `<parameter name="X">` — marker optional —
 * whose body contains at least one COMPLETE inner `<MARKER parameter>` element,
 * closed by a mismatched `</invoke>` / `</calls>` or end. This is the dominant
 * real-world degradation: the tool name moved into a parameter tag while the
 * invoke opener vanished. The nested completes are the authenticity signal: a
 * plain prose `<parameter>` never contains marker-tagged children.
 */
export const wrappedToolRe = (): RegExp =>
  new RegExp(
    `<(?:${MARKER})?parameter\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?[^>]*>` +
      `(?=[\\s\\S]*?${MARKER}parameter\\b)` +
      `([\\s\\S]*?)` +
      `(?=</${MARKER}(?:invoke|${BLOCK_TAG})\\b|$)`,
    "giu",
  )

/**
 * A bare-value orphan parameter (V27, §22 real leak): an orphan
 * `<parameter name="X">VALUE</parameter>` whose body is a **bare value** (no
 * inner marker-tagged children — that is V26) and which is closed by a real
 * `</parameter>` **and** followed by an orphan invoke/block closer OR a
 * marker-bearing block closer.
 *
 * This is the shape where the provider dropped the block opener AND the
 * `invoke name=` opener, keeping only the tool name in the `parameter`
 * attribute and the (keyless) value. It is NOT prose: the trailing closer is
 * the authenticity signal — prose does not close an `<invoke>` it never opened.
 *
 * The grammar captures `(name, value)`; the CALLER binds the value to a key
 * (see `ParseOptions.resolveBareValueKey`) because the key is not in the bytes.
 * Grammar-level authenticity (the closer) is necessary but not sufficient;
 * resolution also requires a schema-derived key, else nothing is recovered.
 *
 * Groups: [1] = tool name, [2] = value.
 */
export const bareValueParameterRe = (): RegExp =>
  new RegExp(
    `<(?:${MARKER})?parameter\\s+name\\s*=\\s*["']?([^"'\\s>]+)["']?[^>]*>` +
      `([\\s\\S]*?)` +
      `</(?:${MARKER})?parameter\\s*>` +
      `(?=[\\s\\S]*?</(?:${MARKER})?(?:invoke|${BLOCK_TAG})\\b|$)`,
    "giu",
  )

/**
 * Any DSML-looking tag at all — used to strip fragments that never formed a full
 * call (stray opens, orphan closers, a bare `parameter` with no invoke). (V9, V10, V12)
 */
export const danglingMarkerRe = (): RegExp =>
  new RegExp(`</?${MARKER}${ANY_TAG}(?:\\s+[^>\\n]*)?>?`, "giu")

/** The end-of-sentence sentinel and its degraded spellings. (V21) */
export const endOfSentenceRe = (): RegExp =>
  new RegExp(`<${BAR}{1,2}\\s*end[\\u2581_\\s]?of[\\u2581_\\s]?sentence\\s*${BAR}{1,2}>`, "giu")

/**
 * Cheap pre-check: skip the whole pipeline when the text cannot contain DSML. The
 * sentinel and `end-of-sentence` are the two things every variant shares. (reject-not-dsml)
 */
export const looksLikeDsml = (text: string): boolean =>
  /DSML|end[\u2581_]of[\u2581_]sentence/i.test(text)
