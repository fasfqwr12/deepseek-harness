# Agent Note: Windowed session residency

Status: proposed

English | [中文](2026-09-19-windowed-session-residency.zh.md)

Related: [cold load shares byte-identical event data](../architecture/2026-09-19-cold-load-shares-duplicate-event-data.md) — landed; this proposal builds the resident-memory endgame on top of it.

## Problem

After the cold-load dedupe, resuming the measured 105MB log costs 139MB resident (down from 483MB). The remaining cost is the full event array itself: 131k event objects stay resident because `Session.log` IS the whole log (`seq === log.length`), and several live plugins re-fold the entire log from seq 0 after every process restart — token-meter's `ReplayState` always starts at `consumedEvents: 0` and reads every event's `data`; the same fold-from-0 shape recurs across telemetry/stats/title consumers. Those folds make the whole log effectively "hot" after each resume, so windowing the array alone cannot reach the <50MB target: each fold-from-0 consumer would re-materialize every windowed-out event.

## Proposal

**Stage 1 — consumer seeding (per consumer, independently shippable).** Migrate each fold-from-0 consumer to seed from sources that already exist: the token-meter seeds its `ReplayState` from its own checkpointed projections (`tokenUsage` totals/last, `contextPressure.surfaceTokens`) plus `session.deriveMessages()` and `session.requestHeader()` — both bounded by the surviving surface — repricing O(surface) once instead of O(log) per restart. Other consumers get the same treatment case by case. Each migration is a cold-start CPU win TODAY and a prerequisite for windowing.

**Stage 2 — windowed log representation.** `Session.fromRestore` gains a `windowStart`: seed entries below it are frozen lazy stubs (`{type, seq, time}` + a `data` getter backed by a per-session loader with a bounded LRU); entries at/above it are today's full events. `seq === log.length` is unchanged; `SurfaceManager` is seeded with `{nodes, replaceGeneration}` computed by a new exported `foldSurfaceState(events)` (the surface fold state is exactly those two fields), so no replay touches stubs; `requestHeader`/`requestContext` fold positions start at `windowStart` with the whole-value last-wins seed (the last header/context is inside the window in the normal case; a single offset read covers the rest).

**Stage 3 — frame-indexed loader.** The JSONL backend records the seq range of each zstd frame during its existing scan and serves `(seq) => SessionEvent` by decoding one frame (~0.1ms) via `fs.readSync` at the frame offset; the in-memory index is ~2MB per open session.

## Alternatives considered

**Proxy-based `events`.** Rejected: iteration (`[...events]`) would silently materialize everything; stubs keep plain frozen-array semantics.

**Compaction-anchored window without stubs.** Rejected: surviving nodes reach back past the last compaction, and `events[seq]` random access (token-meter watermark, telemetry identity checks — 18 src sites) requires old seqs to resolve.

## Acceptance criteria

Resuming the measured 105MB log holds under 50MB resident; a windowed fold produces the same surface state as a full replay; the migrated consumers start from their checkpoints instead of folding from seq 0; and the existing cold-load, persistence, and projection test suites stay green.

## Risks

Every windowed-out event must still resolve through `events[seq]`, so a stub-loading path that a consumer bypasses silently materializes the log again rather than failing. Stage 1 migrates the known fold-from-0 consumers, but an unconverted consumer reintroduces the cost without a visible symptom beyond memory. The frame index assumes the JSONL scan's existing frame boundaries remain authoritative.

## Consequences

After all three stages, resuming the measured log holds stubs (~10MB) + the resident window (last-compaction-anchored, model-context-sized) + the frame index (~2MB) — under the 50MB target. Fold-from-0 CPU disappears from every consumer migrated in stage 1. Consumers that legitimately walk the whole log pay sequential frame decodes, bounded by the same work today's `loadStored` already does.
