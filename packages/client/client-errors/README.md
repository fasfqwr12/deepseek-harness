# @deepseek-ai/dsh-client-client-errors

English | [中文](README.zh.md)

Browser exception reporting. The shell boot kernel (`@deepseek-ai/dsh-client-web`) owns the page's `error`, `window.onerror`, and `unhandledrejection` listeners — they must run even when plugin loading fails — and POSTs one JSON report per failure to `/client-errors/report`. This package owns the endpoint literal and its host half: the route caps the body at `maxBodyBytes` (413 beyond it), ignores anything that is not a report, truncates `stack` to 2000 and `ua` to 200 characters, admits `reportsPerMinute` reports per minute (warning once per exceeded window), and logs every accepted report as one `client-error:` warning. All outcomes answer an empty 204, so page code can never distinguish an accepted report from a rejected one. The browser side adds its own bounds: a reentrancy guard (one report in flight), a 5-second dedupe on kind plus message plus source URL, and a 20-reports-per-minute budget.

## Model Experience

None, as the channel is browser-side diagnostic machinery and nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The endpoint is unauthenticated** — it sits behind the same browser-trust fence as the rest of the web surface, and a report's only effect is a host log line; an authenticated reporter would fail exactly when the page is too broken to authenticate.
- **Reports are truncated and rate-limited** — a report larger than `maxBodyBytes`, a stack past 2000 characters, or a page beyond `reportsPerMinute` is cut rather than spooled, so a runaway page cannot turn the diagnostic channel into a second outage.
- **Dedupe is browser-side only** — the host cannot see repeated failures a page never sent, so a client that drops reports (reentrancy, dedupe, budget) leaves no host-side trace of the drop.
