# Agent Note: Retry override compares by value, not identity

Status: implemented

English | [中文](2026-09-19-retry-override-structural-equality.zh.md)

Related: [cold load shares byte-identical event data](../architecture/2026-09-19-cold-load-shares-duplicate-event-data.md) — this note stops the WRITE side from appending duplicate header snapshots; that note collapses the duplicates already stored on disk at cold-load time. Neither supersedes the other.

## Problem

`callConfigEquals()` is the field-wise real-change detector behind logged `request/header` snapshots: the agent loop appends a full header — call config, rendered system prompt, and every assembled tool schema — whenever `headerEquals()` reports a difference. Its `retryOverride` check compared a `'off' | { maxRetries?, initialDelayMs? }` union with `!==`. That is correct for the primitive forms and wrong for the object form: the session-level retry policy is rebuilt for every request, so two structurally equal policies are never the same reference and the comparator reported a change on every step. The loop then appended a fresh ~63KB header snapshot per step. One measured session carried 3073 header events, 3003 of them (97.8%) byte-identical to their predecessor — 200.9MB of that session's 277.2MB uncompressed log (72%), and the corresponding share of the resident session event array. Only deployments setting a session retry override were affected; without one the field is absent and identity comparison happened to be right.

## Decision

`call-config.ts` gains a module-private `retryOverrideEquals(a, b)`: when both sides are objects it compares `maxRetries` and `initialDelayMs` field-wise, and otherwise falls back to `!==`, which is exact for `'off'`, for `undefined`, and for the mixed object-versus-primitive case. `callConfigEquals()` calls it in place of the identity check; every other field of `LlmCallConfig` was already either primitive or compared element-wise (`stop`).

## Verification

`packages/llm/llm/tests/call-config.spec.ts` covers both forms and the mixed case: distinct instances of one policy compare equal, `'off'` compares equal to `'off'`, differing `maxRetries` or `initialDelayMs` compare unequal, and an object never equals `'off'` or an absent override. The comparator was additionally run against two real `request/header` pairs extracted from a live session log: the byte-identical pair now compares unchanged (it compared changed before the fix), and the pair that genuinely differs in config and system prompt still compares changed. The built `lib/` artifacts keep the pre-fix behavior until the host face is rebuilt, which is what makes the before/after observable on the same data.

## Alternatives considered

**Compare `JSON.stringify` of both overrides.** Rejected: it allocates a string per comparison on the request path and makes the verdict depend on key insertion order.

**Replace the whole function with a generic deep equal.** Rejected: `callConfigEquals` exists to compare named fields, and a generic deep equal would silently start comparing fields that are deliberately primitive or identity-based, while telling callers nothing about which field changed.

**Drop `retryOverride` from the logged header.** Rejected: the retry policy is model-affecting session state that `llm-retry` reads back on resume, so removing it breaks the logged-reconstructs-the-request rule.

**Add a log-write dedupe guard instead of fixing the comparator.** Deferred: a second safety net is worth having, but the comparator is the defect, and a guard would leave every other caller of `callConfigEquals` reporting phantom changes.

## Consequences

A session logs a header snapshot when the request header actually changes, not once per step. Sessions already on disk keep their duplicate snapshots: the fix stops the growth rather than rewriting history, and the resident array those events occupy shrinks only for new sessions. A session retry override remains fully reconstructable from the log, so resume behavior is unchanged.
