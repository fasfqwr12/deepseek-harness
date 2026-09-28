/**
 * Conversation call configuration and freeze utilities. Provider routing,
 * model, reasoning effort, and sampling values are request-header state that
 * can affect cache reuse; request waterfalls replace them and the loop logs
 * changed snapshots instead of allowing silent per-call drift.
 * @module dsh-llm/call-config
 */

import type { GenerateOptions } from './types.ts'
import type { ReasoningEffortId } from './brand.ts'

/** Process-local identities of request objects assembled by dsh-agent-loop. */
const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

// TODO(call-config-shape): Revisit which fields are epoch-level for cache reuse
// and where provider-specific request options belong.
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
  /**
   * 会话级重试覆盖：'off' 关闭重试，或部分覆盖 provider 策略的次数/初始间隔。
   * 随 request/header 持久化，llm-retry 在恢复点读取。
   */
  retryOverride?: RetryOverride
  /** Session image routing: auto by model metadata, native pass-through, bridge caption, or disabled. */
  imageMode?: CapabilityMode
  /** Session web routing: auto/DSH expose local search, native/off suppress it. */
  searchMode?: CapabilityMode
}

/** User-selected routing policy for image and web capabilities. */
export type CapabilityMode = 'auto' | 'native' | 'dsh' | 'off'

/** 会话级重试覆盖值：关闭重试，或覆盖最大次数与初始退避间隔。 */
export type RetryOverride = 'off' | {
  /** 覆盖 provider 策略的最大重试次数。 */
  maxRetries?: number
  /** 覆盖 provider 策略的初始退避间隔（毫秒）。 */
  initialDelayMs?: number
}

/**
 * Effective config fields supplied by exact-model adapter resolution rather
 * than by the caller's request proposal.
 */
export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/**
 * Field-wise equality over the two {@link RetryOverride} forms. The object form
 * is rebuilt for every request, so comparing it by identity would report a
 * change on every step; only the primitives may compare by value directly.
 * @param a - one override.
 * @param b - the other.
 * @returns whether both name the same retry policy.
 */
function retryOverrideEquals(a: RetryOverride | undefined, b: RetryOverride | undefined): boolean {
  if (typeof a === 'object' && typeof b === 'object') {
    return a.maxRetries === b.maxRetries && a.initialDelayMs === b.initialDelayMs
  }
  return a === b
}

/**
 * Field-wise equality over {@link LlmCallConfig} — the comparison a caller
 * runs to decide whether a proposed configuration is a real change (worth a
 * logged header snapshot) or the held one restated.
 * @param a - one configuration.
 * @param b - the other.
 * @returns whether every field (including the `stop` list and the `retryOverride`
 * object, element-wise) matches.
 */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (!retryOverrideEquals(a.retryOverride, b.retryOverride)) return false
  if (a.imageMode !== b.imageMode || a.searchMode !== b.searchMode) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/**
 * Mark one exact request object as assembled by dsh-agent-loop.
 * @param request - loop-owned request envelope before LLM dispatch.
 * @returns the same request object marked as created by the process-local agent loop.
 */
export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

/**
 * Test whether the exact request object was assembled by dsh-agent-loop.
 * @param request - request envelope observed at the LLM waterfall.
 * @returns whether {@link markAgentLoopRequest} recorded this object.
 */
export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}

/**
 * Deep-freeze a value in place with an iterative traversal, guarding cycles,
 * so later mutation throws without imposing a JavaScript call-stack depth cap.
 * {@link AbortSignal} objects are deliberately skipped because they are the
 * request's live cancellation channel and freezing them breaks abort.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}
