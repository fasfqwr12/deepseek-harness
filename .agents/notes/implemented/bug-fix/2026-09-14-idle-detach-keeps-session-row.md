# Agent Note: Idle auto-detach keeps the client session row

Status: implemented

English | [中文](2026-09-14-idle-detach-keeps-session-row.zh.md)

## Problem

The idle auto-detach sweep (30m default, introduced with the cold-history tail windows) disposes the owning agent handle of a session with no appended events for the interval. Disposal removes the session from the in-memory store — by design, since the log stays in persistence and the next interaction resumes it transparently. But the store emits `session/disposed` during that removal, and the host event stream forwarded it to clients as `host/session-removed`, which deletes the sidebar row. The transparent-resume promise then had no entry point: the row was gone, so nothing remained to click. Users saw sessions vanish from the list while switching workspaces (sessions idle past the interval), and a page refresh restored them because the `session.list` baseline merges cold sessions from persistence. The refresh-restore asymmetry proves the data was never lost — only the client row was.

## Decision

The sweep marks each session it initiates disposal for in an `idleDetached` set held by the ApiProxy apply closure. The host stream's `session/disposed` listener consults the set and suppresses the `host/session-removed` frame for marked sessions; the marker clears when the disposal promise settles, so a later genuine disposal of the same session id still notifies. Suppression is scoped to the idle sweep only: every other `session/disposed` emitter (fiber unload, teardown paths) keeps the removal frame, so real deletions stay visible to clients.

## Verification

`api-proxy-cold.spec.ts` gained a regression in the idle auto-detach suite: with a real-dispose bench (session lifecycle folded through `prepare`/`enter`/`announce` with the detach capability retained, so handle disposal fires the genuine `session/disposed` through the store), the sweep's detach produces no host frame — proven by the first observed frame after the silent sweep being the `host/session-removed` of an unmarked manual disposal, not the detached session's. The full apiproxy suite passes (389 tests).

## Alternatives considered

**Have the client re-query persistence on every `host/session-removed`.** Rejected: it moves the detach/delete distinction to the wrong side of the wire, adds a round-trip per removal, and every other client would need the same guard.

**Disable or lengthen the idle interval.** Rejected: treats the symptom and gives up the memory win the detach exists for.

**Emit a distinct `host/session-detached` frame.** Deferred: no client behavior needs it today (the row's stale summary is acceptable; refresh re-baselines), and a new wire event requires schema plus client handling for zero observed benefit.

## Consequences

Sessions idle past the detach interval keep their sidebar rows; clicking such a row resumes the session from storage as the sweep's design intended. A retained row's summary (title, relative time) stays at its last known values until the next `session.list` re-baseline. Genuine disposals — today only teardown paths, since the ApiProxy itself initiates disposal solely through the sweep — still stream the removal frame.
