/**
 * client-errors, browser half: the composition row that pairs the host report
 * endpoint with the page's listeners.
 *
 * The listeners themselves live in the shell boot kernel
 * (`packages/client/web/src/boot.tsx`, `installClientErrorReporting()`): they
 * must run even when plugin loading fails, and the shell may not value-import
 * a plugin package. This half therefore only carries the row so the node half
 * is loaded and the browser graph records the pairing.
 *
 * The endpoint path is written out rather than imported from `../endpoint.ts`:
 * two entries importing one module makes the bundler hoist it into a shared
 * chunk, and the module loader fetches only `lib/client.js`, so the chunk would
 * be unreachable at runtime. `tests/endpoint-sync.client.spec.ts` asserts this
 * literal, the shell's copy, and `../endpoint.ts` all agree.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'client-errors'

/** Required services: none — the report listeners are shell-own and the endpoint is the node half's. */
export const inject = []

/** The report path, duplicated for the bundling reason in the module comment. */
const CLIENT_ERRORS_ENDPOINT = '/client-errors/report'

/**
 * Record the row. The browser-side listeners are installed by the shell before
 * cordis exists, so there is nothing to register here.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.logger.debug(`client-errors: browser listeners are installed by the shell boot kernel (${CLIENT_ERRORS_ENDPOINT})`)
}
