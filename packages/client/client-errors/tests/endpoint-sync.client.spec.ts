/**
 * The report endpoint literal appears in three places by design, and this spec
 * is what keeps them from drifting: `src/endpoint.ts` owns it; the shell boot
 * kernel may not value-import a plugin package (self-sufficiency rule — the
 * loading page must work while plugin loading fails), so
 * `packages/client/web/src/boot.tsx` repeats it; and the browser half repeats
 * it again because a second entry importing the same module makes the bundler
 * hoist a shared chunk the module loader cannot fetch.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLIENT_ERRORS_ENDPOINT } from '../src/endpoint.ts'

const shellSource = readFileSync(fileURLToPath(new URL('../../web/src/boot.tsx', import.meta.url)), 'utf8')
const browserHalfSource = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')

describe('report endpoint literal', () => {
  it('declares the path both halves send to', () => {
    expect(CLIENT_ERRORS_ENDPOINT).toBe('/client-errors/report')
  })

  it('is repeated verbatim by the shell boot kernel', () => {
    expect(shellSource).toContain(`const CLIENT_ERRORS_ENDPOINT = '${CLIENT_ERRORS_ENDPOINT}'`)
  })

  it('is repeated verbatim by the browser half', () => {
    expect(browserHalfSource).toContain(`const CLIENT_ERRORS_ENDPOINT = '${CLIENT_ERRORS_ENDPOINT}'`)
  })
})
