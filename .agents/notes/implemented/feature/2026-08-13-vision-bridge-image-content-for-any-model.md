# Agent Note: Vision bridge — image content for any model via a captioning model

Status: implemented

English | [中文](2026-08-13-vision-bridge-image-content-for-any-model.zh.md)

## Problem

DSH's image pipeline is complete — Web paste/drop upload, durable content-addressed
attachments, the `read_image` tool, and the Pi-AI vision adapter — but image
content only reaches a model whose catalog entry declares `image` input. A text-only
model (the default DeepSeek route hardcodes `inputModalities: ['text']`) cannot
receive image bytes at all; the host `session.prompt` admission refuses the upload
(`packages/host/apiproxy/src/api-proxy.ts`), and the `read_image` tool gates on the
same modality. Users who only have a text model — or any free/local vision model
behind an OpenAI-compatible endpoint — cannot get image content into the
conversation at all, even though a separate vision model could "read" the image for
them.

## Decision

Ship a host-side `vision-bridge` package that decouples *image support* from *model
modality*. A configured OpenAI-compatible vision model captions an image into text;
that text is what the underlying (possibly text-only) model receives. The image
bytes never reach the model that the user is talking to.

- **A `visionBridge` service** (`packages/llm/vision-bridge/src/service.ts`) wraps an
  OpenAI-compatible `/chat/completions` call with an `image_url` content part.
  Configuration (`baseURL` / `apiKey` / `model`) defaults to `VISION_BASE_URL` /
  `VISION_API_KEY` / `VISION_MODEL`, so any free or local vision model works.
- **The host `session.prompt` admission** gains an optional bridge consumer. When the
  selected model is text-only and an image is present, it calls `ctx.get('visionBridge')`
  and, if mounted, captions each image into a `[Image — described by vision model:]`
  text part before persisting the user message. The existing refusal stays when the
  bridge is absent, so behavior is unchanged without the plugin.
- **A `vision_describe` tool** lets any model look at an image *file* on disk on
  demand, returning text. It is registered unconditionally by the plugin but throws a
  clear error if the `visionBridge` service is not mounted.
- The bridge is **composition-conditional**: the service is published with
  `ctx.provide('visionBridge', ...)` and consumed via `ctx.get('visionBridge')`, so
  no other package depends on this one. The host cast to read the optional service is
  localized and documented.

## Alternatives considered

- **Force-declare `image` on text-only models** — rejected. The model's API would
  still reject image bytes; the failure would merely move from preflight to the
  provider call, with a worse error and no benefit.
- **Require a vision-capable primary route** — the pre-existing path: enable
  `llm-pi-ai` with a vision model and switch in the UI. Correct, but the user must
  pick a vision model and pay its cost for every turn, not only the image-bearing
  ones. The bridge keeps the cheap text model as primary and spends vision tokens
  only on the images themselves.
- **Local pixel tooling only (crop/trace/OCR-via-tesseract)** — the
  `vision-tools` reference skill does this for locate/geometry, but extracting
  *meaning* from a screenshot or diagram needs a vision model; pure local ops cannot
  describe arbitrary images. The bridge uses the vision model for description/OCR and
  leaves geometry to dedicated tools.
- **Caption at `read_image` time** — rejected: `read_image` is for durable image
  blocks on vision routes; mixing a text-only captioning path there conflates two
  consumers. The prompt admission is the right seam because it already owns the
  image-vs-modality decision.

## Consequences

- Image content reaches text-only models as text; "upload an image" works regardless
  of the active model's modality when the bridge is configured.
- Vision tokens are spent only on the images, not every turn — cheaper than routing
  the whole conversation through a vision model.
- The original image bytes are dropped from the model-visible message at upload time;
  re-examining an already-uploaded image requires the `vision_describe` tool against a
  file, not the durable attachment.
- Caption quality and any hallucination are bounded by the configured vision model;
  the bridge forwards the image verbatim and returns its text unchanged.
- Only PNG/JPEG/WebP/GIF are forwarded, matching DSH's image admission limits.
- A missing `visionBridge` service leaves the original text-only refusal in place, so
  deployments without a vision endpoint are unaffected.
