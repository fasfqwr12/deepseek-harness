/**
 * client-errors, node half: the host end of the browser exception channel.
 * One exact route (`POST /client-errors/report`) accepts the reports the shell
 * boot kernel's listeners send, bounds the request before parsing it, drops
 * anything that is not a report, and writes every accepted report to the host
 * log — the after-the-fact diagnosis surface for browser failures (an aborted
 * history fetch, a resource that never loaded).
 *
 * The endpoint is deliberately unauthenticated and payload-opaque: it sits
 * behind the same browser-trust fence as the rest of the web surface, and the
 * only thing it can do with a report is log it. Everything it cannot use is
 * answered with the same empty 204, because a browser-side reporter must never
 * be able to distinguish an accepted report from a rejected one (that
 * difference is not actionable at the origin, and a distinguishable error
 * channel invites probing).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Empty type import carries the webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLIENT_ERRORS_ENDPOINT } from './endpoint.ts'

export { CLIENT_ERRORS_ENDPOINT } from './endpoint.ts'

/** Cordis plugin name. */
export const name = 'client-errors'

/** Required service: the route registry the report endpoint registers into. */
export const inject = ['webServer']

/** Report kinds the browser listeners emit. */
const REPORT_KINDS = ['error', 'unhandledrejection', 'resource'] as const

/** One accepted report kind. */
type ReportKind = typeof REPORT_KINDS[number]

/** Stack characters retained per report; longer traces are cut, not dropped. */
const MAX_STACK_CHARS = 2000

/** User-agent characters retained per report. */
const MAX_UA_CHARS = 200

/** Rate-limit window length: one minute, the unit `reportsPerMinute` counts in. */
const RATE_WINDOW_MS = 60_000

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Request-body byte cap; a larger body is answered 413 without being parsed. */
  maxBodyBytes?: number
  /** Accepted reports per minute; further reports in the window are dropped. */
  reportsPerMinute?: number
}

export const Config: z<Config> = z.object({
  maxBodyBytes: z.natural().min(1).default(16384),
  reportsPerMinute: z.natural().min(1).default(60),
})

/**
 * The report fields the channel forwards. The body crosses a wire boundary
 * from arbitrary page code, so every field is checked before use; the type
 * names the accepted subset rather than promising the whole payload.
 */
interface ClientErrorReport {
  kind: ReportKind
  message: string
  href?: string
  ts?: number
  ua?: string
  source?: { url?: string; line?: number; col?: number }
  stack?: string
  tag?: string
}

/**
 * Outcome of reading one request body: the text, an over-cap rejection, or a
 * dropped connection. The three are distinct because only the over-cap case is
 * answerable with 413 — a broken connection is not a report and not an error
 * the page can act on.
 */
type BodyRead =
  | { status: 'read'; text: string }
  | { status: 'over-cap' }
  | { status: 'failed' }

/** Read one request body under a hard byte cap. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const settle = (outcome: BodyRead): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        settle({ status: 'over-cap' })
        return
      }
      chunks.push(chunk)
    })
    // A connection dropped mid-body is not a report; settle so the caller can
    // answer on a response that may still be open.
    req.on('error', () => { settle({ status: 'failed' }) })
    req.on('aborted', () => { settle({ status: 'failed' }) })
    req.on('end', () => { settle({ status: 'read', text: Buffer.concat(chunks).toString('utf8') }) })
  })
}

/** Cut a string to a character budget, keeping short values untouched. */
function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

/**
 * Narrow a parsed body to the accepted report subset.
 * @param value - the parsed JSON value.
 * @returns the report to log, or `undefined` when the value is not a report.
 */
function asReport(value: unknown): ClientErrorReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const kind = REPORT_KINDS.find(candidate => candidate === raw['kind'])
  if (kind === undefined || typeof raw['message'] !== 'string') return undefined
  const report: ClientErrorReport = { kind, message: raw['message'] }
  if (typeof raw['href'] === 'string') report.href = raw['href']
  if (typeof raw['ts'] === 'number') report.ts = raw['ts']
  if (typeof raw['ua'] === 'string') report.ua = truncate(raw['ua'], MAX_UA_CHARS)
  if (typeof raw['tag'] === 'string') report.tag = raw['tag']
  if (typeof raw['stack'] === 'string') report.stack = truncate(raw['stack'], MAX_STACK_CHARS)
  const source = raw['source']
  if (typeof source === 'object' && source !== null) {
    const fields = source as Record<string, unknown>
    const accepted: NonNullable<ClientErrorReport['source']> = {}
    if (typeof fields['url'] === 'string') accepted.url = fields['url']
    if (typeof fields['line'] === 'number') accepted.line = fields['line']
    if (typeof fields['col'] === 'number') accepted.col = fields['col']
    report.source = accepted
  }
  return report
}

/** Answer with the channel's one empty status. */
function respond(res: ServerResponse, status: number): void {
  if (res.headersSent) return
  res.writeHead(status)
  res.end()
}

/**
 * Mount the report endpoint: one exact route, one POST method, one log line
 * per accepted report.
 * @param ctx - host plugin context carrying webServer.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery's .default() guarantees both fields are set after validation.
  const maxBodyBytes = config.maxBodyBytes as number
  const reportsPerMinute = config.reportsPerMinute as number

  let windowStartedAt = 0
  let reportsInWindow = 0
  let dropWarned = false
  // Parse failures are a client-side bug worth seeing once; the channel must
  // not become the log flood it exists to diagnose.
  let parseFailureLogged = false

  /**
   * Admit one report against the per-process window, warning once per exceeded
   * window so a page stuck in an error loop cannot fill the host log.
   */
  const admit = (): boolean => {
    const now = Date.now()
    if (now - windowStartedAt >= RATE_WINDOW_MS) {
      windowStartedAt = now
      reportsInWindow = 0
      dropWarned = false
    }
    if (reportsInWindow >= reportsPerMinute) {
      if (!dropWarned) {
        dropWarned = true
        ctx.logger.warn(`client-errors: dropping reports beyond ${reportsPerMinute}/minute until the next window`)
      }
      return false
    }
    reportsInWindow += 1
    return true
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: CLIENT_ERRORS_ENDPOINT,
      handler: (req, res) => {
        // Named routes match ahead of the carrier's method gate, so this
        // endpoint owns the method decision.
        if (req.method !== 'POST') {
          respond(res, 405)
          return
        }
        // The route owns every outcome: a report channel that rejects is a
        // browser-visible failure of the very surface that reports failures.
        const handle = async (): Promise<void> => {
          const body = await readBody(req, maxBodyBytes)
          if (body.status === 'over-cap') {
            respond(res, 413)
            return
          }
          if (body.status === 'failed') {
            respond(res, 204)
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(body.text)
          } catch {
            if (!parseFailureLogged) {
              parseFailureLogged = true
              ctx.logger.debug('client-errors: ignoring a report body that is not JSON')
            }
            respond(res, 204)
            return
          }
          const report = asReport(parsed)
          if (report !== undefined && admit()) ctx.logger.warn('client-error:', JSON.stringify(report))
          respond(res, 204)
        }
        handle().catch((error: unknown) => {
          ctx.logger.warn(error)
          respond(res, 204)
        })
      },
    })
    return () => { disposeRoute() }
  }, 'client-errors: report endpoint')
}
