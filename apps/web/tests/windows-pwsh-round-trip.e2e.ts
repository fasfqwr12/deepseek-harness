/** Windows keyless Agent Loop acceptance: replayed model -> real pwsh -> durable result. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const SOURCE_FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const SOURCE_PROMPT = 'Use the bash tool to run exactly: echo WEB_E2E_OK. Then reply with the single word DONE and stop.'
const PROMPT = 'Use the pwsh tool to run exactly: Write-Output WEB_E2E_OK. Then reply with the single word DONE and stop.'

describe.skipIf(process.platform !== 'win32')('web e2e: Windows replay reaches the real pwsh tool', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tempDir: string | undefined
  const events: SessionEvent[] = []

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-pwsh-replay-'))
    const source = await readFile(SOURCE_FIXTURE, 'utf8')
    const fixture = source
      .replaceAll(SOURCE_PROMPT, PROMPT)
      .replaceAll('simple bash command', 'simple PowerShell command')
      .replaceAll('\\"name\\":\\"bash\\"', '\\"name\\":\\"pwsh\\"')
      .replaceAll('"name":"bash"', '"name":"pwsh"')
      .replaceAll('\\"command\\": \\"echo WEB_E2E_OK\\"', '\\"command\\": \\"Write-Output WEB_E2E_OK\\"')
      .replaceAll('Echo the test string', 'Write the test string')
      .replaceAll('command executed successfully', 'PowerShell command executed successfully')
    const fixturePath = join(tempDir, 'session.jsonl')
    await writeFile(fixturePath, fixture, 'utf8')
    scaffold = await launchWebScaffold({ replayFixture: fixturePath, paceMs: 15 })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true })
  })

  it('executes pwsh and returns the result to the model', async () => {
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled
    const turnEvents = events
    const call = turnEvents.find(event => event.type === 'tool/call' && event.data.name === 'pwsh')
    if (call?.type !== 'tool/call') {
      const observed = turnEvents
        .filter(event => event.type === 'tool/call')
        .map(event => event.type === 'tool/call' ? event.data.name : '')
      throw new Error('the replayed model did not call pwsh; observed tools: ' + JSON.stringify(observed))
    }
    const result = turnEvents.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === call.data.callId)
    if (result?.type !== 'tool/result') throw new Error('pwsh produced no durable result')
    expect(result.data.message.content[0]?.isError).toBe(false)
    const output = result.data.message.content[0]?.content
      .filter(block => block.type === 'text').map(block => block.text).join('')
    expect(output?.replaceAll('\r\n', '\n')).toBe('WEB_E2E_OK\n')
    const endEvents = turnEvents.filter(event => event.type === 'turn/end')
    if (endEvents.length === 0) {
      throw new Error('the settled replay emitted no turn/end; event types: '
        + JSON.stringify(turnEvents.map(event => event.type)))
    }
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 10_000 }).toBeGreaterThan(0)
  }, 200_000)
})
