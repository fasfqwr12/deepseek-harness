/**
 * Invariant companion of the client-errors package: registration returns a
 * disposer, and the disposal observable — the carrier's own answer on
 * `/client-errors/report` — distinguishes a route that survived teardown from
 * one that left with its fiber. Both directions run against a real node:http
 * server on an OS-assigned port.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CLIENT_ERRORS_ENDPOINT } from '../src/endpoint.ts'
import { apply, inject, name, survivedDisposalMessage } from '../src/invariant.ts'

/** A live carrier double: an HTTP server whose route table is a plain flag. */
interface Carrier {
  readonly port: number
  readonly routeLive: () => boolean
  readonly dispose: () => Promise<void>
}

const carriers: Carrier[] = []

afterEach(async () => {
  while (carriers.length > 0) await carriers.pop()?.dispose()
})

/** Start one carrier; `registered` controls whether the report route is in its table. */
async function startCarrier(registered: boolean): Promise<Carrier> {
  const live = registered
  const server: Server = createServer((req, res) => {
    if (live && req.url === CLIENT_ERRORS_ENDPOINT) {
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('client-errors invariant spec: no bound port')
  const carrier: Carrier = {
    port: address.port,
    routeLive: () => live,
    dispose: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
  carriers.push(carrier)
  return carrier
}

describe('client-errors invariant companion', () => {
  it('registers under its own package name and returns a disposer', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(InvariantRegistry, {})
    await fiber.await()

    const dispose = await apply(ctx)
    expect(typeof dispose).toBe('function')
    // Registration is an effect: the companion must be removable again.
    dispose()
    await fiber.dispose()
  })

  it('reports a route that survived disposal', async () => {
    const carrier = await startCarrier(true)
    const message = await survivedDisposalMessage(carrier.port)

    expect(message).toContain(`${CLIENT_ERRORS_ENDPOINT} still answered 204`)
    expect(carrier.routeLive()).toBe(true)
  })

  it('reports nothing once the route left the carrier', async () => {
    const carrier = await startCarrier(false)
    expect(await survivedDisposalMessage(carrier.port)).toBeUndefined()
  })

  it('reports nothing when the carrier is not listening', async () => {
    const carrier = await startCarrier(true)
    const port = carrier.port
    await carrier.dispose()
    carriers.pop()

    expect(await survivedDisposalMessage(port)).toBeUndefined()
  })

  it('declares the companion identity the invariant registry expects', () => {
    expect(name).toBe('client-errors-invariant')
    expect(inject).toEqual(['invariants'])
  })
})
