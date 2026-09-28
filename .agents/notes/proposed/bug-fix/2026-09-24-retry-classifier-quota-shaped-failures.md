# Retry classifier treats quota-shaped gateway failures as terminal

## Summary

- **Status**: Proposed
- **Date**: 2026-09-24
- **Scope**: `packages/llm/llm`, `packages/llm/llm-pi-ai`

One long-running session against a subscription-to-API relay (650 `llm/retry` events across 11 provider routes) shows the retry engine burning its whole backoff budget on failures that cannot succeed on any attempt: bare `402 status code (no body)` retried 11 times, and one gateway's Chinese quota wall (`您的使用量已超出频率限制，将在 2026-09-24 15:25:52 UTC+8 重置`) retried 20 consecutive times even though the message itself names a reset point hours away. The all-errors retry mode is correct for genuinely transient faults; the missing piece is a terminal classification for failures whose outcome is fixed.

The retry classifier (`classifyPiAiError` in `llm-pi-ai/src/stream.ts`) previously mapped both shapes into retriable codes — `402` fell through to the `PI_AI_ERROR` fallback, and the 429 reset-timestamp wording matched the `RATE_LIMIT` branch. The retry policy retries every code, so both produced pure waiting time: minutes of backoff followed by the same failure.

## Decision

Three classification rules were added, aligned with the plain status-code semantics used by the OpenAI, Anthropic, and Google SDKs (`shouldRetry`: retry 408/429/5xx; treat 402-family quota exhaustion as terminal):

1. **Bare `402` → `QUOTA`** (`llm-pi-ai/src/stream.ts`). A relay gateway that answers `402 status code (no body)` has spent the balance behind the key; the attempt fails identically every time. The class is the terminal quota code, which the retry engine does not retry.
2. **Bare `408` → `TIMEOUT`** (`llm-pi-ai/src/stream.ts`). The plain status names the same transient timeout class as a client-side timeout; all three SDK reference implementations retry it. Ordered after `INVALID_REQUEST` so `400`-wording keeps priority.
3. **Far-future reset horizon → `QUOTA`** (`llm/src/error.ts`, new `isFarFutureRateLimitReset()`). A 429 message that announces a reset point beyond `RATE_LIMIT_QUOTA_HORIZON_MS` (60 s) cannot be waited out inside one request's retry loop. The helper parses absolute timestamps (`YYYY-MM-DD HH:MM[:SS]` with `UTC+8`/`GMT+08:00`/bare `+08:00` zone suffixes) and relative horizons (English `in|after <n> <unit>`, Chinese `<n>小时|分钟|秒后`), and returns false when no parseable horizon exists, so horizon-free rate limits keep the transient `RATE_LIMIT` class. Horizons inside the threshold also stay transient.

The 60-second horizon is a policy floor, not a measured optimum: a retry loop's total backoff budget (8-20 attempts × ≤10 s) can never outwait even a 2-minute window, so any horizon beyond roughly one backoff cycle has the same terminal effect. The constant exists to keep the boundary explicit and testable.

## Evidence from production logs

Classification of the 650 recorded failures after the change: every TRANSPORT/SERVER/TIMEOUT/RATE_LIMIT row keeps its retriable class; the 11 bare-402 rows and 20 quota-wall rows move to `QUOTA`. No previously correct classification regressed. One wording deserves note: `400 status code (no body)` is claimed by pi-ai's Cerebras heuristic (`/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i` in `utils/overflow.js`) before the harness classifier runs, so it remains `CONTEXT_WINDOW_EXCEEDED` — the regression table pins that upstream behavior so a future pi-ai bump surfaces it.

## Verification

- `packages/llm/llm/tests/error-classify.spec.ts` (new): 7 unit cases over `isFarFutureRateLimitReset` — UTC offset application, horizon threshold boundary, English/Chinese relative horizons, no-wording, unparseable timestamp.
- `packages/llm/llm-pi-ai/tests/convert.spec.ts`: 32-row table-driven regression over verbatim production failure texts (clock-independent), plus explicit clock-frozen cases for the far-future reset (`2099-01-01 08:00:00 UTC+8` → `QUOTA`), the past-horizon message (→ `RATE_LIMIT`), bare `402` (→ `QUOTA`), and bare `408` (→ `TIMEOUT`).
- Full `packages/llm` + `packages/llm-pi-ai` suites: 719 passed.
- `tsc -b tsconfig.host.json`: clean.

## Risks

- A gateway that uses `402` for a transient overload (no known instance) would stop retrying where it previously recovered; the fix trades one hypothetical recovery for 31 observed wasted retry cycles.
- The relative-horizon parser accepts only explicit units; a wording like `resets soon` stays `RATE_LIMIT` and keeps retrying, which is the safe default.
- Zone-suffix parsing handles `UTC±h`, `GMT±h[:mm]`, and bare `±hh:mm` before `重置`/`reset`/end-of-string; a timestamp with an unparseable zone falls back to UTC, which can only shorten the computed horizon (transient, retrying) — never the reverse.

## References

- [OpenAI node SDK `shouldRetry`](https://github.com/openai/openai-node/blob/master/src/client.ts) — status-code retry set and `Retry-After` cap.
- [Anthropic TS SDK `shouldRetry`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts) — same status-code set; `APIConnectionError` wording `"Connection error."` matches the production logs verbatim.
- [Google Genai SDK retry config](https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py) — status-code whitelist 408/429/500/502/503/504.

## Consequences

Relay-gateway quota walls and depleted balances now end the step immediately instead of after the full backoff budget; genuinely transient transport, server, timeout, and rate-limit failures keep retrying exactly as before. Future gateway wordings join the regression table, so classifier changes are validated against recorded reality rather than invented fixtures.
