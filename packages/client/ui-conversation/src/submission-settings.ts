/** Busy-Enter preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the conversation plugin. */
export const CONVERSATION_SETTINGS_NAMESPACE = 'ui-conversation'

/** Field carrying the delivery mode for plain Enter while an agent is busy. */
export const BUSY_ENTER_FIELD = 'busyEnter'

/** Field carrying whether Think rows start collapsed instead of following the stream. */
export const THINK_COLLAPSED_FIELD = 'thinkCollapsed'

/** Busy-Enter behaviors accepted at settings and input boundaries. */
export const BUSY_ENTER_BEHAVIORS = ['queue', 'steer'] as const

/** Configurable meaning of plain Enter while the addressed agent is busy. */
export type BusyEnterBehavior = typeof BUSY_ENTER_BEHAVIORS[number]

/** Default preserves Enter-as-Queue for running conversations. */
export const DEFAULT_BUSY_ENTER_BEHAVIOR: BusyEnterBehavior = 'queue'

/** Default keeps Think rows collapsed; the summary line still follows the live stream. */
export const DEFAULT_THINK_COLLAPSED = true

/** Durable conversation section shared by the Host schema and the browser scope. */
export interface ConversationSettings {
  /** Delivery mode for plain Enter while the addressed agent is busy. */
  busyEnter: BusyEnterBehavior
  /** Whether a Think row starts collapsed instead of expanding while streaming. */
  thinkCollapsed: boolean
}

/** Durable conversation schema; also the wire envelope the browser scope validates against. */
export const ConversationSettingsSchema: z<ConversationSettings> = z.object({
  [BUSY_ENTER_FIELD]: z.union([...BUSY_ENTER_BEHAVIORS]).default(DEFAULT_BUSY_ENTER_BEHAVIOR),
  [THINK_COLLAPSED_FIELD]: z.boolean().default(DEFAULT_THINK_COLLAPSED),
})
