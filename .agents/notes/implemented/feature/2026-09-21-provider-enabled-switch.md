# Agent Note: Providers carry a durable enabled switch

Status: implemented

English | [中文](2026-09-21-provider-enabled-switch.zh.md)

## Problem

A configured provider route had exactly two states: configured, and deleted. Every profile in `providers` (pi-ai) or the `llm-deepseek` section registered a route, so a provider whose models a user did not want in the picker — a gateway kept for one legacy model, a route whose quota had run out, one of several interchangeable gateways — could only be removed. Deleting it took the whole profile with it: endpoint, catalog, and the credential reference that had to be re-derived to add it back. The Models page offered Edit and Delete and nothing in between, and the model selector listed every registered route.

## Decision

A profile carries `enabled` (boolean, default `true`). Resolution keeps the field on the resolved profile, so `ResolvedPiAiProviderProfile.enabled` and `DeepSeekConnectionOptions.enabled` are the one place a consumer asks whether a route serves. Two consumers read it:

- **Registration.** `llm-pi-ai` filters the route set it registers to enabled profiles — `servingRoutes(profiles())`, beside a `registrationFacts` that now also excludes disabled profiles, because the registry captures routes at registration and a fact that never varied would keep the route serving. `llm-deepseek` owns one fixed route, so it registers the empty set instead of skipping registration: the handle must exist for a later re-enable to `replace` back.
- **The configurable-provider directory.** Disabled profiles stay listed. The registry reports them `active: false`, which is what keeps them editable on the Models page — a route that vanished from the directory could never be switched back on.

A disabled route therefore leaves every model selector through the mechanism that already exists: `buildModelCatalog` iterates `ctx.llm.listProviders()`, so an unregistered route contributes no group, and the selector's `llm/adapters-updated` subscription refreshes it without a reload.

The Models page renders one **enabled switch** per configured row, reading the resolved section rather than the user layer — a provider switched off in the composition base must not show as on just because the user layer is silent. Enabling **unsets** the field instead of writing `true`: the schema default already means enabled, and a stored `true` would pin the route on against a composition base that later disables it. The write is one path op, so it never rebuilds the section, and a refusal is shown on the row rather than silently reverting the switch.

## Alternatives considered

**Delete the provider and re-add it to re-enable it.** Rejected: it destroys the endpoint, the model list, and the derived credential reference. The profile is exactly the state a user wants to keep.

**Keep the route registered but filter it out of the selector.** Rejected: the route would still answer requests, so a disabled provider would remain reachable by any caller naming it — including a stored session selection. Registration is the one place that decides whether a route serves.

**A separate disabled-providers list in the plugin config.** Rejected: it splits one provider's state across two documents that can disagree, and the profile already owns every other per-route fact.

**Write `enabled: true` when switching a provider back on.** Rejected: it converts a default into an override, so a deployment that later disables the route in its composition base would find the user layer silently re-enabling it.

## Consequences

Disabling every route in a namespace leaves the adapter registered with no routes, which `AdapterRegistrationHandle.replace` explicitly permits. `llm-deepseek` reaches that state through the same `replace` call that carries its retry policy, so switching a route off stays one atomic registry section: an observer on `llm/adapters-updated` sees the route leave once, never an empty-registry window between two registrations.

The switch is per provider, not per model. A profile's `models` list can narrow what a route serves, but there is no per-model enable, and a user who wants one model hidden must remove it from the list.

`pnpm run typecheck`, `packages/llm/llm-pi-ai`, `packages/llm/llm-deepseek`, and `packages/client/ui-settings-models` pin the behavior: the pi-ai suite drives a route off and back on through settings against a mock server and asserts the request fails `NO_ADAPTER` while disabled and streams again once re-enabled; the deepseek suite pins the same through `llm/adapters-updated`, including that no observer sees an empty registry; the client suite pins the rendered state, the `set`/`unset` op each direction writes, the disabled switch on an unconfigured or read-only row, and the on-row failure message.
