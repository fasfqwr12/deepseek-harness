# Agent Note: Bound session memory across persistence and rendering

Status: proposed

English | [中文](2026-09-24-bounded-session-memory.zh.md)

Related: [retry override compares by value](../../implemented/bug-fix/2026-09-19-retry-override-structural-equality.md) — prevents new duplicate request headers. [Cold load shares byte-identical event data](../../implemented/architecture/2026-09-19-cold-load-shares-duplicate-event-data.md) — collapses duplicate parsed data on resume. [Windowed session residency](2026-09-19-windowed-session-residency.md) — owns the BACKEND session log representation (stubs, frame-indexed loader, fold-from-0 consumer seeding) for the measured 105MB log.

Ownership boundary: that note owns how the host process holds a session log; this note owns the two layers it does not cover — the Electron renderer and the browser-side client runtime window — plus the duplicate-header work already landed. Sections below that touch the same 105MB acceptance target defer to it rather than restating a second windowing design; where the two disagree, the backend note's targets win for the host process and this note's bounds win for the renderer.

## Problem

The desktop shell recorded a renderer termination with `reason=oom` after a GPU-process crash. The Electron janitor measured the process owning port 3080, but the process that terminated was the Chromium renderer, so the existing guard did not observe the failing process. The shell log shows the blind spot directly: the last sweep before one OOM recorded `backend WS 656MB (over 0/6)` — the backend was nowhere near its 1.2GB threshold, and renderer memory was never sampled at all. The same log holds three renderer OOMs, and every attempted backend self-heal recorded `deferred` (8 of 8), so no memory event in the log was ever acted on.

A measured session contained 318.9MB of decompressed JSONL. `request/header` events accounted for 222.5MB (69.8%); 3301 of 3380 adjacent header pairs (97.7%) were byte-identical, and only 71 full header payloads occurred across 3381 rows. The same session contains a 12KB system prompt and 62 tool schemas in each header snapshot.

The client has a DOM render window (`TAIL_WINDOW_ROWS = 60`) and fetches pages of 50 messages, but `Session.loadOlder()` prepends events and views without evicting older resident data. `ConversationAssembler` likewise retains inputs and derived contexts for the complete loaded window. DOM virtualization therefore bounds mounted rows but not the JavaScript object graph.

The source tree contains the write-side structural comparator and cold-load data-sharing fixes, and both are present in the artifacts the desktop runtime actually loads (`lib/index.js` for each package, built after the fixed sources). Memory behavior was previously inferred from one process's working set instead of renderer heap and resident-window measurements.

## Proposal

Implement memory bounds at each ownership layer rather than using janitor restarts as the primary optimization.

### 1. Activate and verify existing duplicate-reduction fixes

Both fixes are live in the runtime artifacts; the per-file `lib/types/` output is older than the sources, but each package's `main` points at `lib/index.js`, so that staleness has no runtime effect. Live confirmation from the affected session: three headers logged after the restart with zero adjacent duplicates, against 97.7% adjacent duplicates across the 3380 headers logged before it.

The write path must continue to log a real header change, including retry policy changes. The read path must preserve deep equality and replay semantics while sharing identical `data` object identities.

### 2. Sample renderer memory in the desktop janitor

`main.js` gains `sampleProcessMetrics()`, which reads `app.getAppMetrics()` and reports the maximum working set per process type (`Tab` is this shell's renderer, plus `GPU` and `Browser`). The janitor calls it on each 15-minute sweep and on `render-process-gone`, logging both, so a renderer high-water mark and its crash reason are recorded instead of inferred.

A sustained renderer working set at or above 1.5GB for 3 sweeps rebuilds the window through the existing `rebuildWindow()` path. That action deliberately differs from the backend self-heal: it touches only the renderer, leaving the backend and the JSONL session log intact, so a rebuild cannot lose a running turn. It keeps the backend self-heal's "user is away" gate rather than adding a second, weaker policy.

Verified against a real Electron runtime: `type === 'Tab'` and `memory.workingSetSize` both exist as assumed, and the sampler detects the renderer.

### 3. Keep the DOM render window

Retain the existing `ui-conversation` render window and `ui-trajectory` virtualization. Do not solve data retention by mounting more rows or by rendering the full transcript. The DOM budget remains an implementation detail of the presentation layer and is not the session-memory budget.

### 4. Add a bounded client event window

Give the runtime Session a size- and event-budgeted resident window. Opening a session loads the tail page. The evicted range remains fetchable by sequence; eviction must never delete durable data.

The budget is enforced on the live-append path, which is the only direction that grows without user action: a long streaming step accumulates one Match per chunk, and a measured session held 79,501 `assistant/chunk`, 39,506 reasoning, and 14,406 tool-call chunks that way. `Session.evictOverBudget()` keeps an incrementally maintained `residentSize` (serialized characters) so the check is two comparisons per append; the window is cut back only when a budget is crossed.

Eviction deliberately does NOT run from `loadOlder`. The page a reader just requested is the oldest resident material, so a budget pass there would drop the page it just fetched, raise `baseSeq` onto it, and make the next page-up refetch that same range forever. Paging is instead bounded by the finite durable history it reads; only the append path is budgeted.

A cut never lands inside a Context. The assembler publishes a Context only once its start Match has arrived, so dropping a start while keeping a later Match would leave a start-less Context that accumulates without ever rendering. `ConversationAssembler.evictionBoundary()` answers with the largest Context-safe sequence at or below the cut the budgets asked for, pulling the boundary down to each straddling Context's `startSeq` until none straddle. The retained side is always the live tail, so a running turn is never evicted.

Eviction updates the raw event/view arrays, the base-sequence and `hasMore` metadata, and the assembler's indexes as one operation, so no observer sees a window whose derived Contexts disagree with its events. Raising `hasMore` is what keeps the evicted range reachable rather than lost.

The runtime never retains a second full copy of a window merely to support rendering. Derived rows are rebuilt from the bounded event window, while window-external summaries and projection checkpoints remain compact values.

### 5. Make projection seeding the cold-window contract

Enter and resync should seed projection values from persisted checkpoints and whole-value events, then fold only the resident tail. Older projection state is represented by a checkpoint watermark, not by replaying the complete log in the renderer or host.

The persistence layer should expose sequence-to-byte/frame addressing for older pages. An older page is read on demand and never requires parsing the complete compressed session first.

### 6. Deduplicate request headers without weakening replay

Keep canonical full snapshots at `initial`, `resume`, and genuine `change` boundaries. Do not remove model-visible request state from the durable log. When an unchanged snapshot is encountered, reuse the canonical stored data or reference the existing header identity at the owning layer. Any future on-disk reference format requires a format decision and replay tests; this proposal does not silently introduce a new compatibility format.

### 7. Add renderer-level observability and a safety net

Record renderer process memory, resident event count, resident bytes, projection count, mounted row count, and the session identifier at open, page, eviction, and `render-process-gone` boundaries. Use Electron process metrics and DevTools heap profiling to identify retained owners before changing budgets.

The janitor remains a last-resort backend recovery mechanism. It must not be treated as the normal memory-management algorithm, and it must not claim to protect renderer memory unless it explicitly observes renderer metrics.

## Implementation tracking

- [x] Verify the built artifacts contain the structural retry comparison and duplicate-data sharing. Both fixes are already in the runtime entry (`lib/index.js`, built after the fixed sources); only the per-file `lib/types/` output is stale, and the package `main` does not load it.
- [x] Confirm the write-side fix against live data: 3 headers after the restart with 0% adjacent duplicates, against 97.7% before it.
- [x] Run focused call-config and persistence tests: 115 passed across both suites; the client runtime session and assembler suites are green at 75 passed.
- [x] Sample renderer/GPU/browser working sets in the desktop janitor on every sweep and on `render-process-gone`.
- [x] Add a renderer high-water threshold that rebuilds only the window, keeping the backend self-heal's user-away gate.
- [x] Verify the sampler against a real Electron runtime (`Tab` renderer type and `memory.workingSetSize` both confirmed).
- [x] Add a client resident-window budget with explicit event and size accounting (`RESIDENT_EVENT_BUDGET`/`RESIDENT_SIZE_BUDGET` with half-ceiling drain slack, `Session.residentSize` maintained incrementally at all five write sites).
- [x] Add eviction-safe updates for `Session.events`, `Session.views`, and `ConversationAssembler` indexes (`Session.evictOverBudget()` + `ConversationAssembler.evictionBoundary()`, one `replaceWindow` rebuild from the survivors).
- [x] Prove the boundary never orphans a Context start: 6 focused `evictionBoundary` cases including a chained pull-back, plus 4 Session budget cases (size-budget eviction, live-tip retention, `hasMore` raised, and no eviction under budget). 85 passed across the two client runtime suites; the client compiler face typechecks clean.
- [ ] Preserve scroll anchors across prepend, eviction, reconnect, and resync. The object layer holds no read position (`chatScroll` is presentation-owned), so the stability of `ChatView`'s index-based window (`windowStart`/`tailStart`) against a shrinking transcript is still unverified by test.
- [ ] Add renderer and runtime memory telemetry at lifecycle boundaries.
- [ ] Add a large-session regression fixture and a forced-GC resident-memory measurement for the client window. Current evidence is unit-level budget accounting, not a measured retained-heap reduction.
- [ ] Rebuild the desktop host and verify the live GUI after a controlled restart outside the active conversation backend.
- [ ] Update the related implemented notes if shipped paths or measured results change.
- Host-process windowing (stubs, frame index, fold-from-0 consumer seeding) is tracked by [windowed session residency](2026-09-19-windowed-session-residency.md), not here.

## Acceptance criteria

This note's target is the renderer and client-runtime layers; the 105MB-log resident target for the host process belongs to [windowed session residency](2026-09-19-windowed-session-residency.md).

- The desktop shell records renderer, GPU, and browser working sets on every janitor sweep and on every `render-process-gone`, so a renderer growth trend is visible before it becomes an OOM.
- A renderer at or above the high-water threshold for the sustained sweep count triggers a window rebuild that leaves the backend process and the JSONL session log untouched.
- The live-append path keeps client resident events and size within the configured budget, so a long streaming turn cannot grow the window without bound.
- Paging older history is bounded by the finite durable history it reads, not by the resident budget. Repeated page-up/page-down cycles cannot grow the window without bound, but a reader who pages past the budget holds more than it until the session resyncs; this is the deliberate trade for page-up not livelocking.
- Windowed projection results are byte- and value-equivalent to full replay at every tested cut.
- The measured duplicate-heavy session no longer appends byte-identical headers for structurally equal retry policies.
- Cold load shares byte-identical event data without changing deep equality or replay behavior.
- Focused tests, typecheck, lint, and the applicable GUI/web replay checks pass.

## Alternatives considered

**Only tune janitor thresholds.** Rejected: the janitor watches the port-3080 backend, while the observed failure was a renderer OOM. Restarting the backend does not bound renderer objects, DOM work, duplicate log data, or projection indexes.

**Only increase the V8 or Chromium memory limit.** Rejected: V8 documents its heap limit as protection against leaks; raising it delays failure and can increase garbage-collection pauses. It does not make the event graph bounded.

**Only add renderer sampling to the existing janitor.** Rejected as a complete fix, accepted as the first shipped step: sampling and a window-only rebuild make the failing process observable and give it a bounded recovery, but they act after the renderer has already grown. They do not bound the resident event graph, so client-window work is still required.

**Only virtualize DOM rows.** Rejected: the product already has a render window, but the runtime event/view arrays and assembler indexes still grow as older pages are prepended. Mounted-row count is not resident-data size.

**Delete request/header events.** Rejected: request headers are required to reconstruct model-visible request state and retry policy. The optimization must deduplicate or share them while preserving replay.

## Risks

Evicting events that are still needed by a conversation node can break pairing, location, or timeline state. The shipped boundary rule guarantees only that no surviving Context loses its start Match; it is NOT yet tested with cuts through tool calls, turns, compaction summaries, reconnect gaps, or streaming tails, and those remain required before this leaves proposal state. Location and timeline indexes are re-derived by the same `replaceWindow` rebuild, but that equivalence is asserted by construction rather than by test.

Paging past the budget is unbounded by the resident budget. A reader who pages up through a very large session retains every page they requested until a resync or a live append triggers a budget pass on a window that has since grown. Bounding paging without evicting the page the reader just requested needs a read-position signal the object layer does not currently own.

A size budget can cause more frequent page reads for very large individual events. A single event larger than the whole budget is kept resident rather than dropped, so one oversized event can hold the window above budget indefinitely.

Renderer telemetry adds low-volume metadata to diagnostics. It must not persist full message bodies, prompts, tool schemas, credentials, or attachments.

References:

- [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Chromium OOM investigation](https://chromium.googlesource.com/chromium/src/+/main/docs/memory/oom.md)
- [Chromium memory documentation](https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/memory/README.md)
- [V8 heap size limit](https://v8.dev/blog/heap-size-limit)
- [Electron RenderProcessGoneDetails](https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details)

## Consequences

The system will use more explicit sequence/frame metadata and may perform more page reads when a user explores old history. In exchange, persistence, runtime state, and DOM rendering each receive an independently testable memory bound, while replay correctness and model-visible history remain intact.

This note remains proposed until the bounded client window, built artifact verification, telemetry, and large-session acceptance test are implemented and reviewed.
