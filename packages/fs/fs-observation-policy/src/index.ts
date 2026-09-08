/**
 * Event-only filesystem observation policy; it registers no service. A weak owner/target map
 * records every authoritative presence/absence observation, single-slot intent listeners derive
 * guards from that state, and the provider performs the atomic freshness/no-clobber check. Without
 * this plugin, tools retain the bare provider's unconditional mutation behavior. See the package
 * README for composition rules.
 * @module @deepseek-ai/dsh-fs-observation-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsObservation, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { FsObservationActor } from './types.ts'

export type { FsObservationActor } from './types.ts'

/**
 * Per-context observed-file state and the three `fs/*` decisions over it. One
 * instance is created per `apply()` so disposal can drop all state for HMR.
 */
class ObservedStateGate {
  /**
   * Observed-file state, keyed first by the owner object (weakly held, so a
   * collected session frees its state), then by {@link FsTarget.targetKey}. An
   * entry's presence is the prior-observation record; its discriminant keeps
   * confirmed absence distinct from an unseen target.
   */
  private observed = new WeakMap<object, Map<string, FsObservation>>()

  /**
   * Derive the observed-state owner from the opaque event actor — normally the
   * active agent session. `undefined` when no owner can be derived (e.g. a
   * direct tool call with no agent); such calls read freely but cannot satisfy
   * the write/edit prior-observation policy.
   */
  private owner(actor: object | undefined): object | undefined {
    // tsgolint treats object as assignable to weak FsObservationActor, while tsc still requires the structural cast for property access.
    // See the analyzer-divergence consequence in .agents/notes/implemented/process/2026-07-29-oxlint-linter.md.
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- The analyzers disagree on this weak type.
    return (actor as FsObservationActor | undefined)?.agent?.session
  }

  private get(owner: object, targetKey: string): FsObservation | undefined {
    return this.observed.get(owner)?.get(targetKey)
  }

  private set(owner: object, targetKey: string, observation: FsObservation): void {
    let byTarget = this.observed.get(owner)
    if (!byTarget) {
      byTarget = new Map()
      this.observed.set(owner, byTarget)
    }
    byTarget.set(targetKey, observation)
  }

  /** Drop all recorded state (HMR safety / disposal). */
  clear(): void {
    this.observed = new WeakMap()
  }

  /** Return a version guard only when an authoritative observation exists. */
  writeIntent(target: FsTarget, actor: object | undefined): FsWriteIntent | undefined {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior?.kind === 'present'
      ? { kind: 'replaceIfVersion', version: prior.version }
      : undefined
  }

  /** Return a version guard for observed files; unseen files use the bare provider. */
  editIntent(target: FsTarget, actor: object | undefined): { version: FsVersion } | undefined {
    const owner = this.owner(actor)
    const prior = owner ? this.get(owner, target.targetKey) : undefined
    return prior?.kind === 'present' ? { version: prior.version } : undefined
  }

  /** Record an authoritative present or absent observation for this owner and target. */
  observe(target: FsTarget, observation: FsObservation, actor: object | undefined): void {
    const owner = this.owner(actor)
    if (owner) this.set(owner, target.targetKey, observation)
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-policy'

/**
 * Register the three `fs/*` listeners. No `inject` — this plugin reads no
 * services; it operates only on its own `WeakMap`. The waterfalls are unbound
 * (the tool dispatches them with no `this`), so the listeners take the raw
 * `(target, actor, next)` arguments.
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()

  ctx.effect(() => () => {
    // Drop all recorded state on disposal so a reloaded plugin starts clean
    // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes the
    // release observable and immediate for tests.
    gate.clear()
  }, 'fs-observation-policy observed-state teardown')

  // fs/write-intent: occupy the single decision slot — do NOT call next().
  // Deferred through Promise.resolve().then so the declared Promise return type
  // holds (a throw rejects, never escapes synchronously through the waterfall).
  ctx.on('fs/write-intent', (target, actor, next) => Promise.resolve().then(() => {
    const intent = gate.writeIntent(target, actor)
    return intent ?? next()
  }))

  // fs/edit-intent: use the bare provider when no observation exists.
  ctx.on('fs/edit-intent', (target, actor, next) => Promise.resolve().then(() => {
    const intent = gate.editIntent(target, actor)
    return intent ?? next()
  }))

  // fs/observed must remain synchronous and non-throwing: emit does not await
  // promises, and successful mutations have already committed. WeakMap.set
  // satisfies that contract for both presence and absence.
  ctx.on('fs/observed', (target, observation, actor) => {
    gate.observe(target, observation, actor)
  })
}
