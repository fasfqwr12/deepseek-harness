/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-errors`.
 * @module @deepseek-ai/dsh-client-errors/invariant
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { CLIENT_ERRORS_ENDPOINT } from './endpoint.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-client-errors'

/** Cordis companion plugin name. */
export const name = 'client-errors-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Bound on the disposal probe: a carrier that stops answering is not a violation. */
const PROBE_TIMEOUT_MS = 1_000

/**
 * Status the live route returns for its own method. A POST answered 204 proves
 * the route is still registered; the fallback owner answers an unregistered
 * path (404 in the shipped web composition, whatever a deployment's fallback
 * chooses otherwise), so any status other than 204 is the removal signal.
 */
const REGISTERED_STATUS = 204

/** POST once to the endpoint and report the observed status, or `undefined` when the carrier did not answer. */
async function probeStatus(port: number): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${CLIENT_ERRORS_ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'error', message: 'client-errors invariant disposal probe' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.status
  } catch {
    // The carrier refused, closed, or timed out: nothing was observed about
    // route registration, so this probe has no evidence either way.
    return undefined
  }
}

/**
 * Probe the live endpoint and report whether the route survived disposal.
 * @param port - the carrier's listening port.
 * @returns the failure message when the route still answers as registered, else `undefined`.
 */
export async function survivedDisposalMessage(port: number): Promise<string | undefined> {
  const status = await probeStatus(port)
  if (status !== REGISTERED_STATUS) return undefined
  return `client-errors fiber disposed but ${CLIENT_ERRORS_ENDPOINT} still answered ${status} on the carrier`
}

/**
 * Owned relation: the `/client-errors/report` route must not survive fiber
 * disposal — a route left behind after teardown would keep a dead plugin's
 * handler answering reports (and keep logging them from a stale closure).
 *
 * The observable is the carrier's own response, not this package's bookkeeping:
 * after disposal the probe POSTs to the live endpoint and requires a status
 * other than the registered 204. A package-owned registration counter would
 * only prove the disposer ran, not that the route left the carrier's table.
 *
 * `internal/plugin` fires at dispose start with the fiber's uid cleared; the
 * microtask hop lets the disposer queue its unload before `fiber.await()`
 * joins it. The port is read from the service store at probe time because the
 * fiber's own context (and its `webServer` injection) is gone by then.
 */
const install: InvariantInstaller = (ctx, fail) => {
  const disposed: Fiber[] = []
  // Async listener by design: emitPluginDisposed awaits-and-logs returned
  // promises, so a violation surfaces loudly instead of unhandled.
  // oxlint-disable-next-line typescript/no-misused-promises
  ctx.on('internal/plugin', async (fiber) => {
    if (fiber.name !== 'client-errors') return
    if (fiber.uid !== null) {
      disposed.push(fiber)
      return
    }
    const baseline = disposed.pop()
    if (baseline === undefined) return
    await Promise.resolve()
    await baseline.await()
    const webServer = ctx.get('webServer')
    if (webServer === undefined) return
    const message = await survivedDisposalMessage(webServer.port)
    if (message !== undefined) fail(message)
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
