# Agent Note: google-generative-ai as a configurable wire protocol

Status: implemented

English | [中文](2026-09-19-google-generative-ai-protocol.zh.md)

## Problem

A DSH deployment behind a Gemini backend reachable only through an OpenAI-compat
translation layer (commercial sub2api-style gateways) failed every tool-carrying
request with `400 function_response.name: Name cannot be empty`. Two independent
defects sat in the layer, not in DSH: tool schemas with `type: 'array'` but no
`items` were rejected by Gemini's strict proto validation, and replayed tool
results lost their function names when the assistant message carrying
`tool_calls` omitted `content` (A/B-verified: the identical request with
`content: null` succeeds, with the field omitted fails). DSH's own serialization
is OpenAI-spec-valid; the translation layer is what a route cannot avoid on
that path — the native Gemini endpoint on the same gateway was verified to
serve non-streaming, SSE streaming, and key auth unchanged.

## Decision

Serve `google-generative-ai` from the configurable protocol table, so a route
declares the Gemini-native protocol instead of passing through a lossy
translation layer. pi-ai already ships the implementation
(`@earendil-works/pi-ai/api/google-generative-ai.lazy`, the same factory
`googleProvider()` uses); the harness protocol table in
`packages/llm/llm-pi-ai/src/provider.ts` is the only gate, and its contract
(one line per protocol a deployment can fully describe with a key, an
endpoint, and headers) admits this one: the Google client consumes `baseURL`
verbatim including the version path and authenticates with the harness's
api-key seam, exactly like the other three entries.

- `PROTOCOLS` gains `'google-generative-ai': googleGenerativeAIApi`; the
  settings schema (`z.union(supportedProtocols())`) and every configuration
  surface reading it — including the web GUI's protocol dropdown — follow with
  no UI change of their own.
- `baseURL` carries the version path (`https://gateway.example/v1beta`); pi-ai
  sets `httpOptions.apiVersion = ""` so nothing is appended. A route omitting
  it keeps the catalog Google provider's own `…/v1beta` endpoint.
- Discovery (`GET /models` interrogation) still reports this protocol as
  `DISCOVERY_UNSUPPORTED`, so the models surface falls back to hand-entry —
  correct for gateways whose listing shape is not the native one.
- The `compat` reasoning switches remain `openai-completions`-only; a route on
  this protocol with route-level compat switches is refused, same as before
  for `anthropic-messages`.

## Consequences

- A Gemini-native route stops depending on a third party's translation
  correctness: tool schemas, tool-result names, and streaming semantics are
  the protocol's own, not a conversion's.
- The variant-id pattern works unchanged: model ids the gateway spells
  (`gemini-3-flash`, `gemini-3.1-pro-high`, …) list under the route with
  capacities defaulted per profile, because a route's models inherit the
  table-named protocol through `resolveRouteModels`.
- Existing routes are untouched: the entry adds a choice; nothing rewrites a
  stored profile, and the refusal diagnostic for protocols outside the table
  still names the supported set.

## Verification

- `packages/llm/llm-pi-ai/tests/catalog.spec.ts`: new case asserts
  `supportedProtocols()` contains the protocol and that a declared route
  materializes with the endpoint verbatim; the pre-existing refusal set
  (`bedrock-converse-stream`, `google-vertex`, `azure-openai-responses`,
  `openai-codex-responses`) still excludes it and keeps refusing.
- Full package suite green after the change (55 tests).
- Gateway-side behavior verified against the live endpoint before the change:
  native `POST /v1beta/models/{m}:generateContent`, `?alt=sse` streaming, and
  `x-goog-api-key` auth all served; the OpenAI-compat path failed the two
  translation defects above, which motivated the native route.
