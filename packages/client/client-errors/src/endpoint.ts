/**
 * The one path browser exception reporting uses, shared by both ends of the
 * channel. The browser-side listeners live in the shell boot kernel
 * (`packages/client/web/src/boot.tsx`), which repeats this literal because the
 * shell self-sufficiency rule forbids a value import from a plugin package —
 * the loading page must work while plugin loading fails. The sync spec
 * (`tests/endpoint.client.spec.ts`) reads the shell source from disk and fails
 * when the two literals diverge.
 */
export const CLIENT_ERRORS_ENDPOINT = '/client-errors/report'
