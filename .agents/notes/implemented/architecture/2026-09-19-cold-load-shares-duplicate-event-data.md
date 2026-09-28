# Agent Note: Cold load shares byte-identical event data

Status: implemented

English | [中文](2026-09-19-cold-load-shares-duplicate-event-data.zh.md)

Related: [retry override compares by value](2026-09-19-retry-override-structural-equality.md) — that note stops the WRITE side from appending duplicate header snapshots; this note collapses the duplicates already stored on disk at cold-load time. Neither supersedes the other.

## Problem

Resuming a session parses its entire stored log into distinct event objects. A retry loop's `request/header` snapshots are byte-identical to each other, and each becomes its own parsed copy: one measured 288MB-uncompressed log held 3225 header events, 3104 of them identical to their predecessor, and the same log's tool results repeated identically under retries. Full materialization of that log measured 483MB of live heap, 344MB of it duplicate data. The write-side comparator fix above stops new duplicates; history already on disk still re-materialized one copy per event on every resume.

## Decision

`adoptStoredEvents()` — the exclusively-owned adoption path shared by the JSONL and SQLite backends — now shares one data object between events whose `data` is byte-identical, keyed by the SHA-256 digest of `JSON.stringify(data)`. The map holds only digests, so the keys cost nothing proportional to the data. Deduplication runs after the legacy migrations (identical modern events migrate identically) and before `adoptSessionEvent()`; the resume path constructs the session through `seedSource: 'persistence'` (`Session.fromRestore`), which freezes in place without copying, so shared references survive into the live log. The value is unchanged: every event stays deep-equal to its stored bytes, and only object identity collapses. The deep-copy path (`snapshotStoredEvents()`) is deliberately untouched — it serves bounded tail windows where sharing cannot pay for itself.

## Verification

`packages/session/session-persistence/tests/persistence.spec.ts` cold-loads a stored log with two byte-identical `request/header` events plus an `initial` header and a differing header: the identical pair shares one data object (`toBe`), while the other two keep distinct objects and all four stay deep-equal to their stored bytes. Against the real log above, a forced-GC measurement gave 483MB → 139MB resident (−344MB, −71%) with 7477 shared data objects, at +2.5s on the cold-load path. Repo typecheck, oxlint on the changed files, and the full persistence suite pass; the one failing SQLite case in that run is a pre-existing environmental `EPERM` on symlink creation.

## Alternatives considered

**Dedupe inside Session seed materialization.** Rejected: the resume path already uses `seedSource: 'persistence'` (`fromRestore`, no copy), so adoption is the single place the freshly parsed graph exists; a seed-level memo would also run for replay and fork seeds, which are already detached copies.

**Hash raw line suffixes in the JSONL scanner** (identical line suffix ⇒ identical `data`, no `JSON.stringify`): deferred. It is roughly an order of magnitude cheaper but needs a digest side-channel through `StoredPrefix`, and the planned windowed cold load will stop parsing old events entirely, making both the stringify cost and this optimization moot.

**Store raw JSON strings for old events instead of sharing.** Rejected: the strings alone retain ~288MB for the measured log and still pay a parse on every access.

## Consequences

Resuming a duplicate-heavy log trades ~2.5s of one-time hashing for proportionally less resident memory (the measured session: −344MB of 483MB); the transient parse peak is unchanged because the backend still parses every row before the digest pass. Shared data objects are frozen at the restore boundary like any other event data, so no consumer can observe the aliasing. Sessions written after the comparator fix contain no duplicates and pay only the digest pass on resume.
