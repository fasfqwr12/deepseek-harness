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
export const inject = ['tools', 'fs', 'credentials']

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
  baseURL: z.string().default(''),
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
  const baseURL = normalizeBaseURL(config.baseURL)
  const apiKey = (config.apiKey && config.apiKey.trim()) || (config.apiKeyEnv ? process.env[config.apiKeyEnv] ?? '' : '')
  const model = (config.model && config.model.trim()) || (config.modelEnv ? process.env[config.modelEnv] ?? '' : '')
  if (!baseURL) throw new Error('vision-bridge: baseURL is required (set Config.baseURL or the VISION_BASE_URL credential).')
  if (!apiKey) throw new Error(`vision-bridge: api key is required (set Config.apiKey or the ${config.apiKeyEnv} credential).`)
  if (!model) throw new Error(`vision-bridge: model is required (set Config.model or the ${config.modelEnv} credential).`)
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

interface CredentialSource {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

function normalizeBaseURL(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '')
}

async function resolveRuntimeConfig(ctx: Context, config: Config): Promise<ResolvedVisionBridgeConfig> {
  const credentials = (ctx as unknown as { credentials: CredentialSource }).credentials
  const read = async (ref: string, literal: string | undefined): Promise<string> => {
    const direct = literal?.trim()
    if (direct) return direct
    return (await credentials.resolve(ref))?.value ?? ''
  }
  const [baseURL, apiKey, model] = await Promise.all([
    read('VISION_BASE_URL', config.baseURL),
    read(config.apiKeyEnv ?? 'VISION_API_KEY', config.apiKey),
    read(config.modelEnv ?? 'VISION_MODEL', config.model),
  ])
  const normalizedBaseURL = normalizeBaseURL(baseURL)
  if (!normalizedBaseURL) throw new Error('vision-bridge: baseURL is required (set Config.baseURL or the VISION_BASE_URL credential).')
  if (!apiKey) throw new Error(`vision-bridge: api key is required (set Config.apiKey or the ${config.apiKeyEnv} credential).`)
  if (!model) throw new Error(`vision-bridge: model is required (set Config.model or the ${config.modelEnv} credential).`)
  return {
    baseURL: normalizedBaseURL,
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
 * @param ctx - the plugin context (requires `tools`, `fs`, and `credentials`).
 * @param config - validated, defaulted configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = await resolveRuntimeConfig(ctx, config)
  const bridge: VisionBridge = new OpenAiCompatibleVisionBridge(resolved)
  ctx.provide('visionBridge', bridge)
  applyVisionDescribeTool(ctx)
}
