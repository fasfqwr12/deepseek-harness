# @deepseek-ai/dsh-vision-bridge

A host-side bridge that lets **any** model — including text-only ones — consume
image content. It captions an image through an OpenAI-compatible vision model and
returns text, so the underlying model never receives image bytes.

## Why this exists

DSH's image pipeline (Web upload, durable attachments, `read_image`) is complete,
but a model can only receive an image if its catalog entry declares `image`
input. A text-only model (e.g. plain DeepSeek) physically cannot. This plugin
removes that coupling: image content reaches the model as **text**, produced by a
vision model you point at via `VISION_*` configuration.

## What it does

- Publishes an optional `visionBridge` service (`describe(image) -> text`) backed
  by an OpenAI-compatible `/chat/completions` endpoint that accepts an
  `image_url` content part.
- Registers the `vision_describe` tool so any model can look at an image file on
  disk on demand (returns text).
- The host `session.prompt` admission consumes the service: when a text-only
  model receives an uploaded image, the bridge captions it into text before the
  message is persisted. Upload "just works" regardless of model modality.

## Configuration

Provide the vision endpoint through environment variables (recommended) or the
plugin `Config`:

| Field | Env fallback | Meaning |
| --- | --- | --- |
| `baseURL` | `VISION_BASE_URL` | OpenAI-compatible chat-completions base URL |
| `apiKey` | `VISION_API_KEY` (name from `apiKeyEnv`) | Bearer key |
| `model` | `VISION_MODEL` (name from `modelEnv`) | Vision model id |
| `timeoutMs` | — | Per-request abort timeout (default 60000) |
| `describePrompt` | — | Default free-form description prompt |
| `ocrPrompt` | — | Prompt used when OCR is requested |
| `maxBytes` | — | Maximum image bytes forwarded (default 20 MiB) |

Any free or local OpenAI-compatible vision model works — OpenRouter free tier, a
local VLM (llava/qwen-vl) behind an OpenAI-compat server, etc.

## Enabling

```yaml
- id: vision-bridge
  name: '@deepseek-ai/dsh-vision-bridge'
  config:
    baseURL: https://openrouter.ai/api/v1   # or your local VLM endpoint
    apiKeyEnv: VISION_API_KEY
    modelEnv: VISION_MODEL
```

```sh
export VISION_BASE_URL=https://openrouter.ai/api/v1
export VISION_API_KEY=sk-or-...
export VISION_MODEL=google/gemini-flash-vision-free
```

With the plugin mounted and the env set, upload an image on a text-only model:
the bridge captions it and the model receives the description as text.

## Model Experience

- **User**: uploads a screenshot while the active model is text-only.
- **Host**: detects the text-only route, calls the vision bridge, replaces the
  image with a `[Image — described by vision model:]` text block.
- **Model**: receives only text; it never sees image bytes, so no adapter
  rejects the request.
- **Token / KV-cache**: the description text counts as ordinary model input
  tokens; the original image bytes are not sent to the model at all.

## Known Limitations and Deferred Work

- The bridge captions at upload time and drops the original bytes from the
  model-visible message; re-glancing an already-uploaded image requires the
  `vision_describe` tool pointed at a file, not the durable attachment.
- Caption quality and any hallucination are bounded by the vision model you
  configure; the bridge forwards the image verbatim and returns its text.
- Only PNG/JPEG/WebP/GIF are accepted, matching DSH's image admission limits.
