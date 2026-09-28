/**
 * Node half of the client-errors plugin: the report route accepts one bounded
 * POST, logs the accepted report host-side, and leaves the route table on
 * disposal. Requests are driven through the registered handler directly
 * (`apply` never binds a port); the route's own status codes are the behavior
 * under test.
 */
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { LoggerType } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, CLIENT_ERRORS_ENDPOINT, Config, inject } from '../src/index.ts'

/** Config under test: the cap and the window stay small enough to reach both in one spec. */
const MAX_BODY_BYTES = 64
const REPORTS_PER_MINUTE = 3

interface ResponseSpy {
  readonly status: () => number | undefined
  readonly res: ServerResponse
}

/** Minimal response double: records the one status the route writes and answers `headersSent` like node:http. */
function responseSpy(): ResponseSpy {
  let status: number | undefined
  const double = {
    headersSent: false,
    writeHead(value: number) {
      status = value
      this.headersSent = true
      return this
    },
    end() {
      this.headersSent = true
      return this
    },
    destroy() {},
  }
  return { status: () => status, res: double as unknown as ServerResponse }
}

/** Request double over a real PassThrough, so the body arrives as stream events. */
function requestDouble(method: string): { req: IncomingMessage; body: (text: string) => void } {
  const stream = new PassThrough()
  const req = Object.assign(stream, { method, headers: {} })
  return {
    req: req as unknown as IncomingMessage,
    body: (text: string) => { stream.end(text) },
  }
}

/** One captured log record. */
interface LogRecord {
  type: LoggerType
  args: unknown[]
}

/** A mounted plugin: the live route table, captured log records, and the fiber. */
interface Bench {
  routes: WebRoute[]
  logs: LogRecord[]
  fiber: Fiber
  /** Drive one request through the registered route handler. */
  call: (method: string, body?: string) => { status: () => number | undefined; send: (text: string) => void }
}

async function mount(config: Partial<Config> = {}): Promise<Bench> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const logs: LogRecord[] = []
  const fake: Pick<WebServer, 'register' | 'tapIndex' | 'port'> = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
  ctx.provide('webServer', fake as WebServer)
  // ctx.logger.warn builds a fresh facade per access, so the observable is the
  // exporter stream the facade forwards every record into.
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { logs.push({ type: message.type, args: message.args }) },
  })
  const fiber = ctx.plugin(
    { inject: [...inject], Config, apply },
    { maxBodyBytes: MAX_BODY_BYTES, reportsPerMinute: REPORTS_PER_MINUTE, ...config },
  )
  await fiber.await()
  return {
    routes,
    logs,
    fiber,
    call: (method, body) => {
      const route = routes[0]
      if (route === undefined) throw new Error('client-errors: no registered route')
      const { req, body: send } = requestDouble(method)
      const spy = responseSpy()
      void route.handler(req, spy.res)
      if (body !== undefined) send(body)
      return { status: spy.status, send }
    },
  }
}

const warned = (logs: readonly LogRecord[]): unknown[][] => logs.filter(record => record.type === 'warn').map(record => record.args)

let bench: Bench | undefined

afterEach(async () => {
  await bench?.fiber.dispose()
  bench = undefined
})

describe('client-errors node half', () => {
  it('logs an accepted report and answers 204', async () => {
    // A realistic report carries a source map and a stack, so this case raises
    // the cap; the cap itself is pinned by the over-cap and exact-cap cases.
    bench = await mount({ maxBodyBytes: 4096 })
    const payload = {
      kind: 'error',
      message: 'Failed to fetch',
      href: 'http://127.0.0.1:3080/',
      ts: 1_700_000_000_000,
      ua: 'test-agent',
      source: { url: 'http://127.0.0.1:3080/assets/index.js', line: 3, col: 9 },
      stack: 'Error: Failed to fetch\n    at loadHistory (index.js:3:9)',
    }
    const request = bench.call('POST', JSON.stringify(payload))

    await vi.waitFor(() => { expect(request.status()).toBe(204) })
    const line = warned(bench.logs)
    expect(line).toHaveLength(1)
    expect(line[0]?.[0]).toBe('client-error:')
    expect(JSON.parse(String(line[0]?.[1]))).toEqual(payload)
  })

  it('answers 405 for a non-POST request without logging', async () => {
    bench = await mount()
    const request = bench.call('GET')

    await vi.waitFor(() => { expect(request.status()).toBe(405) })
    expect(warned(bench.logs)).toEqual([])
  })

  it('answers 413 for a body over the cap without logging', async () => {
    bench = await mount()
    const request = bench.call('POST')
    request.send('x'.repeat(MAX_BODY_BYTES + 1))

    await vi.waitFor(() => { expect(request.status()).toBe(413) })
    expect(warned(bench.logs)).toEqual([])
  })

  it('accepts a body at exactly the cap', async () => {
    bench = await mount()
    const exact = JSON.stringify({ kind: 'resource', message: 'm'.repeat(32) })
    expect(exact).toHaveLength(MAX_BODY_BYTES)
    const request = bench.call('POST', exact)

    await vi.waitFor(() => { expect(request.status()).toBe(204) })
    expect(warned(bench.logs)).toEqual([['client-error:', exact]])
  })

  it('answers 204 without warning for a body that is not JSON, then logs the failure once', async () => {
    bench = await mount()
    const first = bench.call('POST', 'not json')
    await vi.waitFor(() => { expect(first.status()).toBe(204) })
    expect(warned(bench.logs)).toEqual([])
    expect(bench.logs.filter(record => record.type === 'debug')).toHaveLength(1)

    const second = bench.call('POST', 'still not json')
    await vi.waitFor(() => { expect(second.status()).toBe(204) })
    // The flood guard: one debug line per plugin activation, not one per body.
    expect(bench.logs.filter(record => record.type === 'debug')).toHaveLength(1)
  })

  it('answers 204 without warning for a payload that is not a report', async () => {
    bench = await mount()
    const request = bench.call('POST', JSON.stringify({ kind: 'nope', message: 'x' }))

    await vi.waitFor(() => { expect(request.status()).toBe(204) })
    expect(bench.logs).toEqual([])
  })

  it('truncates the stack and the user agent before logging', async () => {
    bench = await mount({ maxBodyBytes: 8192 })
    const request = bench.call('POST', JSON.stringify({
      kind: 'unhandledrejection',
      message: 'boom',
      stack: 's'.repeat(3000),
      ua: 'u'.repeat(300),
    }))

    await vi.waitFor(() => { expect(request.status()).toBe(204) })
    const logged = JSON.parse(String(warned(bench.logs)[0]?.[1])) as { stack: string; ua: string }
    expect(logged.stack).toHaveLength(2000)
    expect(logged.ua).toHaveLength(200)
  })

  it('drops reports beyond the per-minute budget and warns once per window', async () => {
    bench = await mount()
    for (let index = 0; index < REPORTS_PER_MINUTE + 2; index += 1) {
      const request = bench.call('POST', JSON.stringify({ kind: 'error', message: `failure ${String(index)}` }))
      await vi.waitFor(() => { expect(request.status()).toBe(204) })
    }

    const reportLines = warned(bench.logs).filter(args => args[0] === 'client-error:')
    expect(reportLines).toHaveLength(REPORTS_PER_MINUTE)
    const dropLines = warned(bench.logs).filter(args => String(args[0]).startsWith('client-errors: dropping'))
    expect(dropLines).toHaveLength(1)
  })

  it('answers 204 even when the request stream errors mid-body', async () => {
    bench = await mount()
    const route = bench.routes[0]
    if (route === undefined) throw new Error('client-errors: no registered route')
    const { req } = requestDouble('POST')
    const spy = responseSpy()
    void route.handler(req, spy.res)
    req.emit('error', new Error('connection reset'))

    await vi.waitFor(() => { expect(spy.status()).toBe(204) })
    expect(warned(bench.logs)).toEqual([])
  })

  it('removes the route on disposal', async () => {
    bench = await mount()
    expect(bench.routes).toHaveLength(1)
    expect(bench.routes[0]).toMatchObject({ kind: 'exact', path: CLIENT_ERRORS_ENDPOINT })

    await bench.fiber.dispose()
    expect(bench.routes).toHaveLength(0)
  })
})
