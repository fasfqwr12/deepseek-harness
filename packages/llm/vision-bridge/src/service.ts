/**
 * The vision-bridge service: caption an image through an OpenAI-compatible
 * vision model and return text. This is the single seam the host prompt
 * admission and the `vision_describe` tool both call, so a text-only model
 * can consume image content without ever receiving image bytes.
 *
 * @module @deepseek-ai/dsh-vision-bridge/service
 */

/** One image to describe. */
export interface VisionDescribeInput {
  /** Raw decoded image bytes. */
  data: Uint8Array
  /** MIME media type, e.g. `image/png`. */
  mediaType: string
  /** Optional targeted question; absence falls back to a describe prompt. */
  question?: string
}

/** A configured vision captioner. */
export interface VisionBridge {
  /** Return a textual description/OCR of the image. */
  describe(input: VisionDescribeInput, signal?: AbortSignal): Promise<string>
}

/** Resolved, non-optional bridge configuration. */
export interface ResolvedVisionBridgeConfig {
  /** Base URL of an OpenAI-compatible chat completions endpoint. */
  baseURL: string
  /** Bearer API key for that endpoint. */
  apiKey: string
  /** Vision model id served by that endpoint. */
  model: string
  /** Per-request abort timeout in milliseconds. */
  timeoutMs: number
  /** Default free-form description prompt. */
  describePrompt: string
  /** Prompt used when the caller requests verbatim OCR. */
  ocrPrompt: string
  /** Maximum image bytes forwarded to the vision endpoint. */
  maxBytes: number
}

/** OpenAI-compatible chat-completions request body (vision subset). */
interface ChatCompletionRequest {
  model: string
  messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >
  }>
  max_tokens: number
}

/** OpenAI-compatible chat-completions response (shape we read). */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
}

/**
 * Caption an image by calling an OpenAI-compatible `/chat/completions`
 * endpoint that accepts an `image_url` content part.
 */
export class OpenAiCompatibleVisionBridge implements VisionBridge {
  /** @param config - resolved, non-optional configuration. */
  constructor(private readonly config: ResolvedVisionBridgeConfig) {}

  async describe(input: VisionDescribeInput, signal?: AbortSignal): Promise<string> {
    if (input.data.byteLength > this.config.maxBytes) {
      throw new Error(
        `vision-bridge: image is ${input.data.byteLength} bytes; the configured limit is ${this.config.maxBytes} bytes`,
      )
    }
    const dataUrl = `data:${input.mediaType};base64,${Buffer.from(input.data).toString('base64')}`
    const text = input.question ?? this.config.describePrompt
    const body: ChatCompletionRequest = {
      model: this.config.model,
      // GLM-4V-Flash caps completion output at 1024. Keeping the bridge at
      // that portable ceiling also remains valid for OpenAI-compatible APIs.
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }

    const controller = new AbortController()
    const onParentAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onParentAbort)
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      throw new Error(
        `vision-bridge: request to ${this.config.baseURL} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onParentAbort)
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`vision-bridge: ${this.config.baseURL} returned ${response.status}: ${detail.slice(0, 500)}`)
    }
    const json = (await response.json()) as ChatCompletionResponse
    const content = json.choices?.[0]?.message?.content
    if (content === undefined) throw new Error('vision-bridge: response contained no message content')
    return content
  }
}
