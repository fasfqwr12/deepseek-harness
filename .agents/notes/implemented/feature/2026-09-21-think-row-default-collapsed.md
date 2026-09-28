# Agent Note: Think rows collapse by default under a durable preference

Status: implemented

English | [中文](2026-09-21-think-row-default-collapsed.zh.md)

## Problem

A live reasoning block mounted with its Think row expanded, because `ReasoningRow` seeded `expanded` from `running`. The row then kept that state through settlement, so a finished transcript carried every chain of thought open: long reasoning chains pushed the actual answer down the page and made a conversation hard to scan. The earlier tail-scroll decision deliberately provided the collapsed summary for a reader who collapsed the row by hand, but nothing let a user ask for collapsed rows in the first place — the expanded live row was the only behavior the product offered.

## Decision

`ReasoningRow` opens collapsed unless the live stream owns the row and the durable preference allows following it: `useState(running && !defaultCollapsed)`, with `defaultCollapsed` a plain prop. A collapsed row keeps the existing single-line summary — latest line while streaming, settled first line afterwards — and its horizontal follow, so collapsed-by-default still communicates provider cadence. Expanding reveals the complete reasoning body as before, and `AssistantMarkdown` renders the Think row chrome-free either way.

The preference is a durable user setting, not a deployment constant: `ui-conversation.thinkCollapsed` (boolean, `DEFAULT_THINK_COLLAPSED = true`) joins `busyEnter` in the existing `ConversationSettingsSchema`, so it resolves through `~/.dsh/settings.yaml`, follows the DSH home across ports, and converges on manual file edits like the other Web preferences. It reaches the render side through the chat node's registrant hooks compartment — `ComposerSubmissionPolicy` publishes `thinkCollapsed` as a `SnapshotStore`, `CHAT_NODE_INJECT` binds it, and the generated `useThinkCollapsed` seat carries it to `AssistantNodeView` → `AssistantMarkdown` → `ReasoningRow`. The Settings page gains a `think-collapsed` row beside `composer-enter`.

Because the browser bundle reloads without restarting the Host, a Host whose registered schema predates the field resolves no value for it; `adopt` therefore keeps the local default when the section omits `thinkCollapsed` rather than adopting `undefined`.

## Alternatives considered

**Flip the hardcoded `useState(running)` to `useState(false)`.** Rejected: it removes the live expansion the tail-scroll decision chose, with no way to get it back, and hardcodes a product-visible default that the placement already varies per user.

**A cordis.yml `Config` field on the ui-conversation plugin.** Rejected: this is a per-user reading preference that must survive under the user's DSH home, not a deployment topology choice. A config field would need a Host restart to change and would not travel with `settings.yaml`.

**Keep disclosure state in browser `localStorage`.** Rejected for the same reason the Appearance and busy-Enter preferences left it: origin-scoped storage loses the choice on another port even though both processes share a DSH home.

**Auto-collapse only after settlement.** Rejected: it still opens every live chain of thought, which is the reading burden the preference exists to remove, and it would make the row jump as a turn ends.

## Consequences

Reasoning chains no longer push answers off-screen, and the summary line remains the live cadence signal, so the tail-scroll behavior survives in the collapsed presentation. The preference is durable and port-independent; a user who wants the old behavior selects "跟随流式展开" and gets it per user rather than per deployment.

Two costs are accepted. The default changes visible transcript output, so existing readers see collapsed Think rows after this ships; the summary is the only affordance that still moves. And the render path now carries one more prop through three components plus a hook binding, which is the price of routing a durable preference through the sanctioned registrant hooks compartment instead of reading a service from a presentation component.

## Testing

`packages/client/ui-conversation/tests/reasoning-row.client.spec.tsx` pins that a collapsed default keeps the live summary and expands on click, in both streaming and settled states, while the existing expansion and settlement tests continue to pass with `thinkCollapsed` absent. `packages/client/ui-conversation/tests/submission-policy.client.spec.ts` covers publishing before the durable write, adoption from the scope, and the schema-skew case that keeps the local default. `packages/client/ui-conversation/tests/host.client.spec.ts` pins schema registration, the resolved defaults, and rejection of a non-boolean value.
