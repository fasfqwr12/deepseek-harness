/**
 * Harness error base with a stable machine-routable code and chained cause.
 * Package errors extend it so tool results and replay can retain failure class.
 * @module @deepseek-ai/dsh-llm/error
 */

/**
 * Base class for all harness errors. Carries a `code` (stable, programmatic —
 * e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
 * human-readable `message`, and supports `cause` chaining via the standard
 * `ErrorOptions`. `name` defaults to the subclass constructor name.
 */
export class HarnessError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

/** Canonical provider-neutral code for a model request rejected because its context window was exceeded. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** Canonical provider-neutral code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = 'QUOTA'

/**
 * Canonical provider-neutral code for a response that completed normally but
 * carried no content blocks at all. Providers occasionally emit a degenerate
 * completion (a terminal stop with zero output); adapters classify it as this
 * failure instead of yielding an empty assistant message, because an empty
 * message silently ends the turn with nothing for the user or the loop to act
 * on. The attempt produced nothing durable, so retry policy treats it as safe
 * to repeat.
 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Canonical provider-neutral code for a credential that was supplied but
 * cannot be used — malformed rather than absent. Distinct from
 * `MISSING_CREDENTIAL` because the fix differs: correct the stored value
 * rather than supply one. Deliberately outside the default retryable set —
 * a malformed credential fails identically on every attempt.
 */
export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/**
 * Recognize the context-overflow wording used by OpenAI-compatible providers
 * and library adapters. Adapters pass all available provider code, type, and
 * message text so both thrown and in-band delivery styles share one classifier.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true when the detail identifies a request exceeding the model context window.
 */
export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

/**
 * Recognize provider wording that identifies an exhausted account quota rather
 * than a transient request-rate limit.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true only for terminal quota, balance, credit, budget, or usage-limit wording.
 */
export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/**
 * Reset horizon beyond which a rate limit is treated as a quota: waiting out
 * the reset inside one request's retry loop cannot plausibly succeed, so the
 * failure is terminal for this turn.
 */
export const RATE_LIMIT_QUOTA_HORIZON_MS = 60_000

/** Absolute datetime (`YYYY-MM-DD HH:MM[:SS]` spelling; the timezone suffix is matched separately). */
const ABSOLUTE_RESET = /(\d{4}-\d{2}-\d{2})[\s_T]+(\d{2}:\d{2}(?::\d{2})?)/

/** Zone suffixes that follow the timestamp in provider prose (`UTC+8`, `GMT+08:00`, bare `+08:00`). */
const ZONE_SUFFIX = /\b(?:UTC|GMT)\s*([+-])(\d{1,2})(?::(\d{2}))?\b|\b([+-])(\d{2}):?(\d{2})\b(?=\s*(?:重置|reset)|$)/i

/** Relative horizons: English `in|after <n> <unit>` and Chinese `<n><unit>后`, each with an explicit unit. */
const RELATIVE_RESET =
  /\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(h|hr|hour|hours|minute|minutes|min|second|seconds|s|m)\b|(\d+(?:\.\d+)?)\s*(小时|分钟|秒)后/i

/**
 * Recognize a rate-limit message that announces a reset point too far in the
 * future to wait out inside a retry loop. Chinese gateways phrase the quota
 * wall as a reset timestamp (`…将于 2026-09-24 15:25:52 UTC+8 重置`); the same
 * contract appears in English as `resets in 5 minutes`. A horizon within
 * {@link RATE_LIMIT_QUOTA_HORIZON_MS} stays a transient RATE_LIMIT; beyond it
 * the message is quota semantics — retrying until exhaustion only burns
 * minutes.
 * @param detail - provider error code/type/message text joined into one string.
 * @param now - reference clock for horizon arithmetic (defaults to the real clock).
 * @returns true when the message carries a reset horizon beyond the quota threshold.
 */
export function isFarFutureRateLimitReset(detail: string, now: number = Date.now()): boolean {
  const absolute = ABSOLUTE_RESET.exec(detail)
  if (absolute !== null) {
    const zone = ZONE_SUFFIX.exec(detail)
    const offsetMinutes = zone === null ? 0
      : (zone[1] ?? zone[4]) === '-' ? -1
        : 1 * (Number(zone[2] ?? zone[5]) * 60 + Number(zone[3] ?? zone[6] ?? 0))
    const parsed = Date.parse(`${absolute[1]}T${absolute[2]}${offsetMinutes === 0 ? 'Z' : `${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(offsetMinutes) % 60).padStart(2, '0')}`}`)
    if (!Number.isNaN(parsed)) return parsed - now > RATE_LIMIT_QUOTA_HORIZON_MS
  }
  const relative = RELATIVE_RESET.exec(detail)
  if (relative !== null) {
    // English branch captures (value, unit); the Chinese branch captures
    // (value, unit) with its own unit group at index 4.
    const value = Number(relative[1] ?? relative[3])
    const unit = relative[2] ?? relative[4]
    if (Number.isFinite(value) && value > 0 && unit !== undefined) {
      const unitMs = /^(?:h|hr|hour|hours|小时)$/i.test(unit) ? 3_600_000
        : /^(?:m|minute|minutes|分钟)$/i.test(unit) ? 60_000 : 1_000
      return value * unitMs > RATE_LIMIT_QUOTA_HORIZON_MS
    }
  }
  return false
}

/**
 * Render a thrown value with its full `cause` chain and AggregateError
 * members, so transport wrappers like undici's `TypeError: fetch failed`
 * surface the underlying failure instead of masking it. Plain structured
 * failures render their own data-backed `message`. Diagnostic-surface
 * rendering only (messages, notices, logs) — never parse the result; route on
 * {@link HarnessError.code}.
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns the outermost message first, each cause appended with `: ` (skipped
 * when it repeats the wrapper message verbatim), and AggregateError members
 * bracketed and `; `-joined.
 */
export function errorChain(value: unknown): string {
  // Tracks the active recursion path (entries removed on exit), so only true
  // cycles are flagged and a diamond-shared cause still renders in full.
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // Wrappers like `new HarnessError(String(value), code, { cause: value })`
      // repeat their cause verbatim; rendering it again would only add noise.
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // Only hostile coercion or hostile accessors (a throwing toString /
      // Symbol.toPrimitive on a non-Error, or a throwing message/name/cause/
      // errors getter on an Error subclass): this renderer feeds UI notices
      // and logs, so nothing may escape. Inner frames catch their own throws,
      // so only the hostile node collapses, not the whole chain.
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

/**
 * Narrow an arbitrary thrown value to a HarnessError (for `instanceof` at runtime boundaries).
 * @param value - the caught value (`unknown` in catch clauses).
 * @returns true only for real instances; duck-typed or cross-realm errors do not narrow.
 */
export function isHarnessError(value: unknown): value is HarnessError {
  return value instanceof HarnessError
}
