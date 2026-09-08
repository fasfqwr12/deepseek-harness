/** Event-level policy tests; no filesystem provider is needed because the plugin performs no I/O. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsObservation, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { FsObservationActor } from '@deepseek-ai/dsh-fs-observation-policy'

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}
const ownerExec = (session: object): FsObservationActor => ({ agent: { session } })
const present = (version: string): FsObservation => ({ kind: 'present', version: FsVersion(version) })
const absent: FsObservation = { kind: 'absent' }

/** Dispatch the write-intent waterfall with the bare default thunk. */
function writeIntent(ctx: Context, t: FsTarget, actor: object | undefined): Promise<FsWriteIntent | undefined> {
  return ctx.waterfall('fs/write-intent', t, actor, () => undefined)
}
/** Dispatch the edit-intent waterfall with the bare default thunk. */
function editIntent(ctx: Context, t: FsTarget, actor: object | undefined): Promise<{ version: FsVersion } | undefined> {
  return ctx.waterfall('fs/edit-intent', t, actor, () => undefined)
}

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(FsPolicy)
  return { ctx, fiber }
}

async function dispatchWrite(ctx: Context, t: FsTarget, actor: object | undefined): Promise<{ intent: FsWriteIntent | undefined, nextCalled: boolean }> {
  let nextCalled = false
  const intent = await ctx.waterfall('fs/write-intent', t, actor, () => {
    nextCalled = true
    return undefined
  })
  return { intent, nextCalled }
}

async function dispatchEdit(ctx: Context, t: FsTarget, actor: object | undefined): Promise<{ intent: { version: FsVersion } | undefined, nextCalled: boolean }> {
  let nextCalled = false
  const intent = await ctx.waterfall('fs/edit-intent', t, actor, () => {
    nextCalled = true
    return undefined
  })
  return { intent, nextCalled }
}

describe('registration / disposal', () => {
  it('registers no service API (it is a plugin, not ctx.fsPolicy)', async () => {
    const { ctx } = await setup()
    expect((ctx as Context & { fsPolicy?: unknown }).fsPolicy).toBeUndefined()
  })

  it('mounts with no inject (reads no services)', async () => {
    // It mounts immediately even with nothing else in the context.
    const ctx = new Context()
    await ctx.plugin(FsPolicy)
    expect(await writeIntent(ctx, target('a.txt'), undefined)).toBeUndefined()
  })
})

describe('write-intent decision', () => {
  it('an unobserved target falls through to the bare provider', async () => {
    const { ctx } = await setup()
    expect(await dispatchWrite(ctx, target('a.txt'), ownerExec({}))).toEqual({ intent: undefined, nextCalled: true })
  })

  it('a no-owner actor falls through to the bare provider', async () => {
    const { ctx } = await setup()
    expect(await dispatchWrite(ctx, target('a.txt'), undefined)).toEqual({ intent: undefined, nextCalled: true })
    expect(await dispatchWrite(ctx, target('a.txt'), {})).toEqual({ intent: undefined, nextCalled: true })
  })

  it('an actor with an agent but no session falls through to the bare provider', async () => {
    const { ctx } = await setup()
    expect(await dispatchWrite(ctx, target('a.txt'), { agent: {} })).toEqual({ intent: undefined, nextCalled: true })
  })

  it('an observed target decides replaceIfVersion at the observed version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v7'), exec)
    expect(await writeIntent(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v7' })
  })

  it('an unobserved or absent target uses the bare provider', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    expect(await writeIntent(ctx, target('a.txt'), exec)).toBeUndefined()
    ctx.emit('fs/observed', target('a.txt'), absent, exec)
    expect(await writeIntent(ctx, target('a.txt'), exec)).toBeUndefined()
  })
})

describe('edit-intent decision', () => {
  it('allows an unread edit to use the bare provider', async () => {
    const { ctx } = await setup()
    expect(await editIntent(ctx, target('a.txt'), ownerExec({}))).toBeUndefined()
  })

  it('allows an edit with no owner to use the bare provider', async () => {
    const { ctx } = await setup()
    expect(await editIntent(ctx, target('a.txt'), undefined)).toBeUndefined()
  })

  it('allows an edit whose actor has an agent but no session', async () => {
    const { ctx } = await setup()
    expect(await editIntent(ctx, target('a.txt'), { agent: {} })).toBeUndefined()
  })

  it('returns the observed version as the CAS basis after an observation', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v3'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v3' })
  })

  it('allows editing a target observed absent through the bare provider', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), absent, exec)
    expect(await dispatchEdit(ctx, target('a.txt'), exec)).toEqual({ intent: undefined, nextCalled: true })
  })
})

describe('observed-state is the prior-observation record', () => {
  it('a read observation authorizes an in-place write at that version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec) // a read
    expect(await writeIntent(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })

  it('a write/edit observation refreshes the basis, so the next edit needs no re-read', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    // A create records v1; the follow-up edit guards against v1 with no read.
    ctx.emit('fs/observed', target('a.txt'), present('v1'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v1' })
    // The edit records v2; a second edit guards against v2.
    ctx.emit('fs/observed', target('a.txt'), present('v2'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v2' })
  })

  it('a no-owner observation records nothing', async () => {
    const { ctx } = await setup()
    ctx.emit('fs/observed', target('a.txt'), present('v0'), undefined)
    // Still unobserved for any owner, so the bare provider is used.
    expect(await editIntent(ctx, target('a.txt'), ownerExec({}))).toBeUndefined()
  })

  it('supports present → absent → present transitions for one owner', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    const a = target('a.txt')
    ctx.emit('fs/observed', a, present('v1'), exec)
    expect(await writeIntent(ctx, a, exec)).toEqual({ kind: 'replaceIfVersion', version: 'v1' })

    ctx.emit('fs/observed', a, absent, exec)
    expect(await writeIntent(ctx, a, exec)).toBeUndefined()
    expect(await editIntent(ctx, a, exec)).toBeUndefined()

    ctx.emit('fs/observed', a, present('v2'), exec)
    expect(await editIntent(ctx, a, exec)).toEqual({ version: 'v2' })
  })
})

describe('multi-owner isolation', () => {
  it('owner A observing does not grant owner B edit authority', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), a)
    expect(await editIntent(ctx, target('a.txt'), b)).toBeUndefined()
    expect(await editIntent(ctx, target('a.txt'), a)).toEqual({ version: 'v0' })
  })

  it('each owner records its own observed version independently', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), a) // A observed v0
    // B never observed → bare provider; A still holds v0 → replaceIfVersion.
    expect(await dispatchWrite(ctx, target('a.txt'), b)).toEqual({ intent: undefined, nextCalled: true })
    expect(await writeIntent(ctx, target('a.txt'), a)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })
})

describe('single-slot, first-wins', () => {
  it('calls next() for an unobserved target', async () => {
    const { ctx } = await setup()
    expect(await dispatchWrite(ctx, target('a.txt'), ownerExec({}))).toEqual({ intent: undefined, nextCalled: true })
  })

  it('a SECOND decider registered AFTER fs-observation-policy is not reached (first-wins short-circuit)', async () => {
    const { ctx } = await setup()
    let secondRan = false
    // Registered after fs-observation-policy, so it dispatches second; fs-observation-policy does
    // not call next(), so this never runs. (A decider registered BEFORE — or with
    // prepend — would instead win: first-wins is by convention, not enforced.)
    ctx.on('fs/edit-intent', () => {
      secondRan = true
      return Promise.resolve(undefined)
    })
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec)
    await editIntent(ctx, target('a.txt'), exec)
    expect(secondRan).toBe(false)
  })

  it('a SECOND write-intent decider can run after an unobserved target falls through', async () => {
    const { ctx } = await setup()
    let secondRan = false
    ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve(undefined)
    })
    await writeIntent(ctx, target('a.txt'), ownerExec({}))
    expect(secondRan).toBe(true)
  })
})

describe('disposal releases recorded state (HMR safety)', () => {
  it('a fresh plugin after disposal starts with no inherited state', async () => {
    const ctx = new Context()
    const exec = ownerExec({})
    const fiber = await ctx.plugin(FsPolicy)
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v0' })
    await fiber.dispose()

    await ctx.plugin(FsPolicy)
    // Same owner object, but state was released on disposal, so it falls through.
    expect(await dispatchEdit(ctx, target('a.txt'), exec)).toEqual({ intent: undefined, nextCalled: true })
  })

  it('no listeners remain after disposal (the gate no longer decides)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FsPolicy)
    await fiber.dispose()
    // With no listener, the waterfall falls through to the bare default.
    expect(await writeIntent(ctx, target('a.txt'), ownerExec({}))).toBeUndefined()
  })
})
