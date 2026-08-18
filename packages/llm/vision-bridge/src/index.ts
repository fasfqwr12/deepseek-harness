/**
 * `vision-bridge` plugin: publishes a `visionBridge` service that captions
 * images through an OpenAI-compatible vision model, and registers the
 * `vision_describe` tool. The host prompt admission consumes the service to let
 * a text-only model receive uploaded images as text, and the tool lets any model
 * look at an image file on demand. Neither path sends image bytes to the
 * underlying model, so "image support" becomes independent of model modality.
 *
 * @module @deepseek-ai/dsh-vision-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyVisionDescribeTool } from './tool.ts'
import { OpenAiCompatibleVisionBridge, type ResolvedVisionBridgeConfig, type VisionBridge } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vision-bridge'

/** Services this plugin requires before it can register the bridge and tool. */
export const inject = ['tools', 'fs']

/** Plugin configuration. Every credential defaults to an environment variable. */
export interface Config {
  /** OpenAI-compatible chat-completions base URL. Defaults to `VISION_BASE_URL`. */
  baseURL?: string
  /** Bearer API key. Defaults to the variable named by `apiKeyEnv`. */
  apiKey?: string
  /** Environment variable that holds the API key. Defaults to `VISION_API_KEY`. */
  apiKeyEnv?: string
  /** Vision model id. Defaults to `VISION_MODEL`. */
  model?: string
  /** Environment variable that holds the model id. Defaults to `VISION_MODEL`. */
  modelEnv?: string
  /** Per-request abort timeout in milliseconds. */
  timeoutMs?: number
  /** Default free-form description prompt. */
  describePrompt?: string
  /** Prompt used when OCR is requested. */
  ocrPrompt?: string
  /** Maximum image bytes forwarded to the vision endpoint. */
  maxBytes?: number
}

/** Validated, defaulted configuration schema. */
export const Config: z<Config> = z.object({
  baseURL: z.string().default(process.env.VISION_BASE_URL ?? ''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().default('VISION_API_KEY'),
  model: z.string().default(''),
  modelEnv: z.string().default('VISION_MODEL'),
  timeoutMs: z.number().min(1).default(60_000),
  describePrompt: z
    .string()
    .default('Describe this image in detail: visible objects, text, UI elements, layout, and anything notable.'),
  ocrPrompt: z.string().default('Transcribe all text in this image verbatim, preserving line breaks.'),
  maxBytes: z.number().min(1).default(20 * 1024 * 1024),
})

/**
 * Resolve configuration into the non-optional form the service needs, reading
 * credentials from environment variables when the literal config omits them.
 * @param config - the user-supplied (and schema-defaulted) config.
 * @returns resolved configuration, or throws if a required endpoint field is absent.
 */
export function resolveConfig(config: Config): ResolvedVisionBridgeConfig {
  const baseURL = config.baseURL?.trim()
  const apiKey = (config.apiKey && config.apiKey.trim()) || (config.apiKeyEnv ? process.env[config.apiKeyEnv] ?? '' : '')
  const model = (config.model && config.model.trim()) || (config.modelEnv ? process.env[config.modelEnv] ?? '' : '')
  if (!baseURL) throw new Error('vision-bridge: baseURL is required (set Config.baseURL or the VISION_BASE_URL environment variable).')
  if (!apiKey) throw new Error(`vision-bridge: api key is required (set Config.apiKey or the ${config.apiKeyEnv} environment variable).`)
  if (!model) throw new Error(`vision-bridge: model is required (set Config.model or the ${config.modelEnv} environment variable).`)
  return {
    baseURL,
    apiKey,
    model,
    timeoutMs: config.timeoutMs ?? 60_000,
    describePrompt: config.describePrompt ?? 'Describe this image in detail.',
    ocrPrompt: config.ocrPrompt ?? 'Transcribe all text in this image verbatim.',
    maxBytes: config.maxBytes ?? 20 * 1024 * 1024,
  }
}

/**
 * Register the vision-bridge service and the `vision_describe` tool.
 * @param ctx - the plugin context (requires `tools` and `fs`).
 * @param config - validated, defaulted configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const bridge: VisionBridge = new OpenAiCompatibleVisionBridge(resolved)
  // Optional service: the host prompt admission reads it via ctx.get and keeps
  // its existing text-only refusal when the bridge is not mounted.
  ctx.provide('visionBridge', bridge)
  applyVisionDescribeTool(ctx)
}
