# Agent Note: pi-ai compat exposes supportsDeveloperRole for strict gateways

Status: implemented

## Problem

pi-ai's `openai-completions` transport decides the system prompt's wire role by endpoint-URL recognition: `supportsDeveloperRole` defaults to true for every URL it does not recognize, and a declared reasoning model's system prompt goes out as an OpenAI `developer` message. Strict gateways — new-api relaying a backend that only accepts the classic roles (GLM, for one) — reject the role, and the relay passes the upstream rejection through as `422 {"message":"openai_error","type":"bad_response_status_code",…}`. The failure masqueraded as a thinking-level problem: declaring `reasoningEfforts` flipped the role, so a route worked with no levels declared and failed with them, regardless of the selected level. The reasoning-dispatch switches the configuration exposes ([pi-ai per-model reasoning declarations](../feature/2026-08-08-pi-ai-per-model-reasoning-declarations.md)) could not express "keep the system prompt a `system` message", so no configuration could fix the route; a local role-rewriting proxy was the only workaround.

## Decision

`PiAiCompatProfile` gains `supportsDeveloperRole?: boolean`, resolved on the same model → route → installed catalog entry → pi-ai URL-guess chain as the two reasoning switches and threaded into the model's `OpenAICompletionsCompat`, which is where pi-ai's role decision (`model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"`) reads it. Declaring `false` keeps a reasoning model's system prompt a `system` message. The switch exists only on `openai-completions` like the other two: a model-level switch on another protocol fails resolution, a route-level default skips models of other protocols, and a route with no completions model at all is refused.

## Alternatives considered

- **Extend pi-ai's URL detection with known relay hostnames.** Lost: the set is open-ended — new-api deployments share no hostname, so the guess stays wrong for the next gateway, and per-deployment configuration is the only durable correction.
- **Rewrite the role in a local proxy** (this deployment already runs one for a Gemini `store` quirk). Lost: another always-on process per broken gateway with auth and streams relayed through user-managed code, when a declarative switch makes the transport speak correctly by itself.
- **Serve the route over the `anthropic-messages` protocol**, which carries the system prompt in a top-level field and never emits the role. Lost as the general fix: it changes the wire dialect wholesale and abandons `openai-completions` dispatch behavior; it remains a working escape for gateways that also speak Anthropic, and is how this deployment's GLM route runs until its harness is rebuilt.

## Consequences

Bought: a reasoning-declaring model on a strict openai-completions gateway works with no proxy and no protocol change, and the fix is declarative configuration rather than code local to one deployment. Cost: the compat profile now mixes reasoning-dispatch switches with one transport-role switch, so its name and README framing say "reasoning-dispatch" while the surface is slightly wider. Still open: pi-ai's guess remains optimistic for unrecognized URLs, so a gateway that silently drops a `developer` message instead of rejecting it still needs the explicit `false` — no detection here can catch a silent drop.

## Testing

`catalog.spec` pins the resolution: route-level `false` lands on a declared reasoning model, a model-level switch wins over the route, and a model-level switch on a non-completions protocol fails resolution. Verified against the failing gateway with a capture proxy: with the switch, requests carry `["system","user"]` and then `["system","user","assistant","tool"]` and complete with tool calls and reasoning blocks where the same route without the switch failed 422 on every attempt.
