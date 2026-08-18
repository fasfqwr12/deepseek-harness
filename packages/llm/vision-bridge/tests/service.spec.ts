import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleVisionBridge, type ResolvedVisionBridgeConfig } from '../src/service.ts'

function makeConfig(overrides: Partial<ResolvedVisionBridgeConfig> = {}): ResolvedVisionBridgeConfig {
  return {
    baseURL: 'https://example.test/v1',
    apiKey: 'key-test',
    model: 'vision-model',
    timeoutMs: 1000,
    describePrompt: 'Describe this image.',
    ocrPrompt: 'Transcribe verbatim.',
    maxBytes: 1024,
    ...overrides,
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('OpenAiCompatibleVisionBridge', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('posts the image as a base64 data URL and returns the message content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a red square' } }] }),
    } as Response)
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig())
    const text = await bridge.describe({ data: PNG_BYTES, mediaType: 'image/png' })

    expect(text).toBe('a red square')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/chat/completions')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('vision-model')
    expect(body.max_tokens).toBe(1024)
    expect(body.messages[0].content[0].text).toBe('Describe this image.')
    expect(body.messages[0].content[1].image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
    )
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-test')
  })

  it('uses the caller question instead of the default describe prompt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'top-left' } }] }),
    } as Response)
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig())
    await bridge.describe({ data: PNG_BYTES, mediaType: 'image/png', question: 'where is the logo?' })
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.messages[0].content[0].text).toBe('where is the logo?')
  })

  it('throws when the endpoint is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as Response)
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig())
    await expect(bridge.describe({ data: PNG_BYTES, mediaType: 'image/png' })).rejects.toThrow(
      'vision-bridge: https://example.test/v1 returned 401: unauthorized',
    )
  })

  it('throws when the response carries no content', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) } as Response)
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig())
    await expect(bridge.describe({ data: PNG_BYTES, mediaType: 'image/png' })).rejects.toThrow(
      'vision-bridge: response contained no message content',
    )
  })

  it('refuses an image above the configured byte limit', async () => {
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig({ maxBytes: 4 }))
    await expect(bridge.describe({ data: PNG_BYTES, mediaType: 'image/png' })).rejects.toThrow(/the configured limit is 4 bytes/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts and surfaces a fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const bridge = new OpenAiCompatibleVisionBridge(makeConfig())
    await expect(bridge.describe({ data: PNG_BYTES, mediaType: 'image/png' })).rejects.toThrow(
      'vision-bridge: request to https://example.test/v1 failed: network down',
    )
  })
})
