/**
 * The `vision_describe` tool: read an image from the filesystem and return a
 * textual description or OCR produced by the configured vision model. It
 * returns text only, so it works on any model — including text-only ones —
 * which is the whole point of the bridge: the agent gains eyes without the
 * underlying model needing image input.
 *
 * @module @deepseek-ai/dsh-vision-bridge/tool
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { VisionBridge } from './service.ts'

/** Extension to declared image media type, used only to label the request. */
const MEDIA_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Largest image the tool forwards to the vision endpoint. */
const TOOL_MAX_BYTES = 20 * 1024 * 1024

/**
 * Map a model-supplied path to a declared image media type by extension.
 * @param filePath - the raw `image_path` argument.
 * @returns the media type, or `image/png` when the extension is unrecognized.
 */
export function mediaTypeForPath(filePath: string): string {
  return MEDIA_BY_EXT[extname(filePath).toLowerCase()] ?? 'image/png'
}

/**
 * Register the `vision_describe` tool into the given context. The tool reads an
 * image through `ctx.fs`, captions it through the optional `visionBridge`
 * service, and returns only text, so it is usable on text-only models.
 * @param ctx - the registration scope; execution uses `ctx.fs` and `ctx.get('visionBridge')`.
 */
export function applyVisionDescribeTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'vision_describe',
    description:
      'Read an image file from disk and describe or OCR it using a configured vision model. Returns text only, so it works on any model including text-only ones.',
    parameters: {
      image_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      question: {
        type: 'string',
        description: 'Optional targeted question about the image instead of a free-form description.',
      },
      ocr: {
        type: 'boolean',
        description: 'When true, transcribe all text in the image verbatim instead of describing it.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.image_path.trim().length === 0) throw new Error('image_path must be a non-empty string')
      const bridge = ctx.get('visionBridge') as VisionBridge | undefined
      if (bridge === undefined) {
        throw new Error(
          'vision_describe requires the vision-bridge service: configure VISION_BASE_URL / VISION_API_KEY / VISION_MODEL (or the vision-bridge plugin).',
        )
      }
      const target = await ctx.fs.resolve(args.image_path, { signal: exec.signal })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`vision_describe: no such file: ${args.image_path}`)
      const data = await ctx.fs.readBytes(target, exec.signal, TOOL_MAX_BYTES)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const input: { data: Uint8Array; mediaType: string; question?: string } = {
        data,
        mediaType: mediaTypeForPath(args.image_path),
      }
      if (args.question !== undefined) input.question = args.question
      const text = await bridge.describe(input, exec.signal)
      return text
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Describe image ${args.image_path}`,
        kind: 'read',
        locations: [{ path: args.image_path }],
      }
    },
  }))
}
