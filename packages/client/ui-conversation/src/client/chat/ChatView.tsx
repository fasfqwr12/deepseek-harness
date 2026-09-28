// ChatView: the default conversation view — one stable keyed parent list over
// final business Nodes, plus paging, pending steering and bottom-follow.
// Each row dispatches through 'conversation.chat.node'; ui-tool owns the
// tool-call renderer and its recursive root/subcall composition.
//
// Scroll: when nested under `[data-conversation-scroll]` (active conversation
// column), that host is the scrollport and this view is flow content; when
// mounted alone (unit tests), `.scroll` owns overflow. Bottom-follow and
// prepend anchoring always target the resolved scrollport.
//
// Render economics: order changes only when rows enter, leave or move. Each
// ChatNodeSeat subscribes to one Node key, so Assistant deltas and Tool
// lifecycle updates replace only their own row without remounting it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { PendingSteeringBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { formatRunDuration } from './message-chrome.ts'
import css from './ChatView.module.css'

const FOLLOW_THRESHOLD = 24
/** Reader-scroll distance from the head that arms auto-paging. */
const TOP_PAGE_THRESHOLD = 48
/**
 * Render window (mounted rows, not loaded history): open shows only the
 * latest TAIL_WINDOW_ROWS even when hundreds of pages already live in the
 * session snapshot — mounted heavy nodes (Markdown, code blocks, tool cards)
 * are what pinned the renderer main thread on 60MB+ transcripts.
 */
const TAIL_WINDOW_ROWS = 60
/** Rows revealed per step when the window head moves up. */
const WINDOW_PAGE_ROWS = 40
/** Context rows kept above the restored scroll anchor after a remount. */
const RESTORE_ANCHOR_SLOP = 8
/** Pixel gap between the page being dropped and the viewport top before
 *  inverse paging reclaims it; keeps a fast scroll from culling visible rows. */
const RECLAIM_SLOP_PX = 8

/** Active column host when present; otherwise the view-local scroller. */
function scrollerOf(from: HTMLElement): HTMLElement {
  return (from.closest('[data-conversation-scroll]')) ?? from
}

interface PagingAnchor {
  /** Stable node/call identity, independent of boundary-spanning group keys. */
  key: string
  /** Row top relative to the scrollport after the latest user scroll. */
  top: number
}

/** Find an already-rendered settled row without interpolating a selector. */
function anchorElement(list: HTMLElement, key: string): HTMLElement | null {
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row
  }
  return null
}

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** Select a visible stable node/call identity, falling back only when layout
 * has not exposed a visible box yet. */
function pagingAnchor(list: HTMLElement, scrollport: HTMLElement): HTMLElement | null {
  const viewport = scrollport.getBoundingClientRect()
  const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
  const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
  // Scroll events are hot: hit-test a few points through the stretched flow
  // rows before considering the full mounted set. The fallback keeps jsdom
  // and pre-layout states deterministic; a virtualizer naturally bounds it.
  if (typeof document.elementsFromPoint === 'function' && visibleBottom > viewport.top) {
    const content = list.getBoundingClientRect()
    const left = Math.max(viewport.left, content.left)
    const right = Math.min(viewport.right, content.right)
    const x = left + Math.max(0, right - left) / 2
    const height = visibleBottom - viewport.top
    const points = [1, Math.min(32, height / 3), height / 2, Math.max(1, height - 1)]
    for (const offset of points) {
      for (const element of document.elementsFromPoint(x, viewport.top + offset)) {
        const row = element instanceof HTMLElement
          ? element.closest<HTMLElement>('[data-chat-anchor-key]')
          : null
        if (row !== null && list.contains(row)) return row
      }
    }
  }
  const rows = [...list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
  const visibleRows = rows.filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.bottom > viewport.top && rect.top < visibleBottom
  })
  return visibleRows[0] ?? rows[0] ?? null
}

type ChatScrollPosition = NonNullable<ReturnType<ChatViewSlotProps['chatScroll']['read']>>

/** Capture a reflow-resistant reader position from the current rendered window. */
function scrollPosition(list: HTMLElement, scrollport: HTMLElement): ChatScrollPosition | null {
  const row = pagingAnchor(list, scrollport)
  const anchorKey = row?.dataset.chatAnchorKey
  if (row === null || anchorKey === undefined) return null
  return {
    anchorKey,
    anchorTop: flowTop(row, scrollport),
    scrollTop: scrollport.scrollTop,
  }
}

function runningTurnStartTime(timeline: ConversationTimelineSnapshot): number | null {
  let latest: number | null = null
  for (const turn of timeline.turns.values()) {
    if (turn.status === 'open' && turn.start !== undefined) latest = turn.start.time
  }
  return latest
}

/** Turn-level model activity label retained across first-token, tool, and streaming phases. */
function TurnStatus({ startTime, t }: {
  /** The running turn's logged `turn/start` time; null falls back to mount
   *  time when that boundary is outside the window. */
  startTime: number | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real
  // elapsed time and the final footer's Ran-for label matches this clock.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => {
      setElapsedMs(Math.max(0, Date.now() - anchor))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // Short turns keep the plain label; the clock only appears once the turn
  // has clearly been running for a while.
  const showClock = elapsedMs >= 15_000
  return (
    <div className={css.turnStatus} role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className={css.turnStatusClock} aria-hidden>
          {formatRunDuration(elapsedMs, t)}
        </span>
      )}
    </div>
  )
}

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useSessions, useStore, renderSlot, sessionId, openFile, loadOlder, loadImage, releaseImage,
  inspectCall, chatScroll, forkAt,
  fileMentions, t,
}: ChatViewSlotProps) {
  const order = useSession(s => s.chat.order)
  const nodeStore = useSession(s => s.chat.nodes)
  const timeline = useSession(s => s.chat.timeline)
  const inbox = useSession(s => s.queue)
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const selectedCallId = useStore(s => s.selection?.callId)

  const pendingSteering = useMemo(
    () => inbox.filter(item => item.placement === 'steering'),
    [inbox],
  )
  const runningTurnStart = useMemo(() => runningTurnStartTime(timeline), [timeline])

  const listRef = useRef<HTMLDivElement | null>(null)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Last position delivered or written on the main thread. */
  const observedTopRef = useRef(0)
  /** Paging anchor: semantic row/position at click, updated by reader scrolls
   * while the request is pending and restored after the prepend lands. */
  const anchorRef = useRef<PagingAnchor | null>(null)
  const firstSeqRef = useRef<number | null>(null)
  const openedRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  const lastSteeringIdRef = useRef<string | null>(null)
  /** Flow tip signature — follow-scroll only when this moves, never on a
   *  scroll-driven at-bottom chrome re-render (which would snap inertial
   *  scrolls the rest of the way to the floor). */
  const followSigRef = useRef<string | null>(null)
  /**
   * Sliding render window head index into `order`; the tail is always the
   * newest row. null means "not aligned yet": the first open commit derives
   * the tail window below, so a huge already-loaded transcript never mounts
   * its full row set even once (alignment lands in the pre-paint layout
   * effect). Session remounts (SessionProvider keys the subtree by session
   * id) reset the state.
   */
  const [windowStart, setWindowStart] = useState<number | null>(null)
  /** Local window expansion/reclaim anchor — no request involved, unlike
   * anchorRef which belongs to the backend prepend path. */
  const localAnchorRef = useRef<PagingAnchor | null>(null)

  /** Head index that keeps exactly the tail window mounted. */
  const tailStart = Math.max(0, order.length - TAIL_WINDOW_ROWS)
  /** Effective head for this commit: the tail window until alignment lands. */
  const windowHead = windowStart ?? (openState === 'open' ? tailStart : 0)
  const visibleKeys = useMemo(
    () => (windowHead === 0 ? order : order.slice(windowHead)),
    [order, windowHead],
  )
  /** Loaded rows currently held out of the mounted window, if any. */
  const hiddenHeadRows = windowHead

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const lastNode = lastKey === null ? undefined : nodeStore.get(lastKey)
  const lastSteeringId = pendingSteering[pendingSteering.length - 1]?.id ?? null
  const followSig = `${openState}:${firstSeq}:${lastKey}:${order.length}:${running ? 1 : 0}:${lastSteeringId ?? ''}`

  const toBottom = (el: HTMLElement): void => {
    anchorRef.current = null
    localAnchorRef.current = null
    // Reclaim the expanded window: unmount rows above the tail window so the
    // mounted DOM stays bounded however far the reader paged up. The floor is
    // always the latest tail window — a previously expanded head (start well
    // above 0) collapses back to tailStart, and a start left past a grown
    // tailStart clamps down with it. The browser shrink-clamps scrollTop onto
    // the (shorter) floor, and the observed-top ledger knows that clamp.
    setWindowStart(tailStart)
    el.scrollTop = el.scrollHeight
    observedTopRef.current = el.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
    chatScroll.save(null)
  }

  /** Capture the row currently under the viewport as the local window anchor;
   * the pre-paint layout effect restores its viewport position after the
   * mounted set changes (delta is signed, so it serves both head expansion
   * and head reclaim). */
  const armLocalAnchor = (el: HTMLElement): void => {
    const local = listRef.current
    if (local === null) return
    const row = pagingAnchor(local, el)
    if (row !== null && row.dataset.chatAnchorKey !== undefined) {
      localAnchorRef.current = { key: row.dataset.chatAnchorKey, top: flowTop(row, el) }
    }
  }

  /** Reveal one page of already-loaded rows hidden above the window head. */
  const expandWindow = (): void => {
    if (windowHead <= 0) return
    const local = listRef.current
    if (local !== null) armLocalAnchor(scrollerOf(local))
    setWindowStart(start => Math.max(0, (start ?? windowHead) - WINDOW_PAGE_ROWS))
  }

  /** Drop one head page once it sits entirely above the viewport, keeping
   *  the mounted list bounded while the reader moves downward — including a
   *  window fully expanded to the loaded head — without waiting for a
   *  back-to-bottom click. */
  const reclaimHead = (el: HTMLElement): void => {
    // Already at the smallest tail window: nothing to reclaim, and no
    // geometry read on an otherwise hot scroll path.
    const nextHead = Math.min(
      windowHead + WINDOW_PAGE_ROWS,
      Math.max(0, order.length - TAIL_WINDOW_ROWS),
    )
    if (nextHead <= windowHead) return
    const local = listRef.current
    if (local === null) return
    // Flow seats map 1:1 onto mounted order rows (nested tool-seat anchors
    // carry no flow key): the guard row is the last row of the dropped page.
    const guard = local.querySelectorAll<HTMLElement>('[data-chat-flow-key]')[WINDOW_PAGE_ROWS - 1]
    if (guard === undefined) return
    const viewportTop = el.getBoundingClientRect().top
    if (guard.getBoundingClientRect().top > viewportTop - RECLAIM_SLOP_PX) return
    armLocalAnchor(el)
    setWindowStart(nextHead)
  }

  useLayoutEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: React attaches the ref before layout effects run. */
    if (local === null) return
    const el = scrollerOf(local)
    // Open completed: jump to the bottom once — unless a scroll position
    // survives from a previous mount (view-tab switch away and back), which
    // is restored instead of snapping the reader back to the floor.
    if (openState === 'open' && !openedRef.current) {
      const saved = chatScroll.read()
      // Align the render window before the first position write: tail window
      // for a fresh open, or a window containing the saved semantic row for a
      // remount restore. Defer the open branch until the aligned rows mount.
      let alignedStart = tailStart
      if (saved !== null) {
        const anchorIndex = order.indexOf(saved.anchorKey)
        if (anchorIndex >= 0) {
          alignedStart = Math.max(0, Math.min(anchorIndex - RESTORE_ANCHOR_SLOP, tailStart))
        }
      }
      if (windowStart !== alignedStart) {
        setWindowStart(alignedStart)
        return
      }
      openedRef.current = true
      if (saved === null) {
        toBottom(el)
      } else {
        el.scrollTop = saved.scrollTop
        const row = anchorElement(local, saved.anchorKey)
        if (row !== null) el.scrollTop += flowTop(row, el) - saved.anchorTop
        observedTopRef.current = el.scrollTop
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD + 1
        atBottomRef.current = isAtBottom
        setAtBottom(isAtBottom)
        const normalized = isAtBottom ? null : scrollPosition(local, el)
        if (isAtBottom) chatScroll.save(null)
        else if (normalized !== null) chatScroll.save(normalized)
      }
      firstSeqRef.current = firstSeq
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    // A shrinking transcript (compaction/removal) can push the saved head
    // past the new tail window: clamp before rendering an empty window.
    if (windowStart !== null && windowStart > tailStart) {
      setWindowStart(tailStart)
      return
    }
    // Local window expansion (no history request): keep the anchored row at
    // the same viewport position after extra mounted rows appear above it.
    // The delta is signed, so head reclaim rides the same compensation.
    if (localAnchorRef.current !== null) {
      const localAnchor = localAnchorRef.current
      const localRow = anchorElement(local, localAnchor.key)
      if (localRow !== null) {
        localAnchorRef.current = null
        el.scrollTop += flowTop(localRow, el) - localAnchor.top
        observedTopRef.current = el.scrollTop
      }
    }
    // Prepend (head seq decreased): preserve the same settled row at the
    // position established by the reader's latest scroll. This excludes
    // unrelated tail/composer growth while the request was in flight.
    if (anchorRef.current !== null && firstSeq !== null && firstSeqRef.current !== null && firstSeq < firstSeqRef.current) {
      const anchor = anchorRef.current
      anchorRef.current = null
      const row = anchorElement(local, anchor.key)
      if (row !== null) el.scrollTop += flowTop(row, el) - anchor.top
      observedTopRef.current = el.scrollTop
      firstSeqRef.current = firstSeq
      /* v8 ignore next -- ?? arm: a prepend adds nodes, so the flow list here is never empty. */
      lastKeyRef.current = lastKey
      lastSteeringIdRef.current = lastSteeringId
      followSigRef.current = followSig
      return
    }
    firstSeqRef.current = firstSeq
    // Own words must be visible: a new trailing user node force-scrolls
    // (send lives in the composer, so arrival is detected here, not armed there).
    const appendedUser = lastKey !== lastKeyRef.current && lastNode?.kind === 'user'
    const appendedSteering = lastSteeringId !== null && lastSteeringId !== lastSteeringIdRef.current
    const tipMoved = followSigRef.current !== followSig
    lastKeyRef.current = lastKey
    lastSteeringIdRef.current = lastSteeringId
    followSigRef.current = followSig
    // Follow new flow content while pinned; do NOT re-pin on every render
    // merely because atBottomRef is true (scroll threshold → setState → snap).
    if (appendedUser || appendedSteering || (tipMoved && atBottomRef.current)) toBottom(el)
  })

  const onScrollRef = useRef(() => {})
  onScrollRef.current = () => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the handler only fires while mounted. */
    if (local === null) return
    const el = scrollerOf(local)
    // Only reader input may make raw scroll geometry change follow ownership:
    // a delivered position that deviates from the observed-top ledger (every
    // programmatic write records itself there synchronously). This covers
    // wheel, touch, scrollbar, and keyboard alike without naming devices.
    // Browser shrink-clamps land exactly on the floor min and delayed
    // programmatic deliveries land on the ledger itself, so both preserve
    // the current ownership state.
    const floor = Math.max(0, el.scrollHeight - el.clientHeight)
    const movedByReader = Math.abs(el.scrollTop - Math.min(observedTopRef.current, floor)) > 0.5
    const isAtBottom = movedByReader
      ? floor - el.scrollTop <= FOLLOW_THRESHOLD + 1
      : atBottomRef.current
    if (!movedByReader && isAtBottom) {
      toBottom(el)
      return
    }
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    const position = isAtBottom ? null : scrollPosition(local, el)
    if (isAtBottom) {
      anchorRef.current = null
    } else if (anchorRef.current !== null && position !== null) {
      anchorRef.current = { key: position.anchorKey, top: position.anchorTop }
    }
    // Continuous save (unmount happens after ref detach, so saving there is
    // too late); pinned-to-bottom clears so a remount keeps following.
    if (isAtBottom) chatScroll.save(null)
    else if (position !== null) chatScroll.save(position)
    observedTopRef.current = el.scrollTop
    // Auto-page near the head: reveal locally-windowed loaded rows first
    // (instant, no RPC); only once the window reaches the loaded head does
    // scrolling here fetch an older backend page. Either path's compensation
    // moves the reader off the threshold, so idling at the head does not
    // re-fire; loadingOlder serializes the backend requests.
    if (!isAtBottom && el.scrollTop <= TOP_PAGE_THRESHOLD) {
      if (windowHead > 0) expandWindow()
      else if (hasMore && !loadingOlder) loadOlderAnchored()
    } else if (!isAtBottom) {
      // Inverse paging while reading downward keeps the mounted list bounded
      // without a back-to-bottom click: head pages already above the viewport
      // are dropped, with anchor compensation holding the visible content.
      reclaimHead(el)
    } else if (el.scrollTop >= floor - 0.5 && windowHead !== tailStart) {
      // Flush with the floor (any window shape): reclaim the tail window.
      // The shrink-clamp delivery is recognized as non-reader input.
      localAnchorRef.current = null
      setWindowStart(tailStart)
    }
  }

  // Bind the scroll listener on the resolved scrollport once per mount;
  // reader-input attribution rides the observed-top ledger, not per-device
  // input listeners.
  useEffect(() => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: effect runs after the list node commits. */
    if (local === null) return
    const el = scrollerOf(local)
    const onScroll = (): void => { onScrollRef.current() }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // The ref starts null and is assigned every render, so the placeholder
  // initializer a function initial value would need never exists.
  const followRef = useRef<(() => void) | null>(null)
  followRef.current = () => {
    const local = listRef.current
    if (local !== null && atBottomRef.current) {
      const el = scrollerOf(local)
      el.scrollTop = el.scrollHeight
      observedTopRef.current = el.scrollTop
      chatScroll.save(null)
    }
  }
  // Streaming, tool disclosures, and other flow changes resize the column;
  // the sticky composer resizes outside it. This observer owns ChatView's
  // dynamic-height follow decisions and writes only while the reader is pinned.
  useEffect(() => {
    const column = columnRef.current
    const local = listRef.current
    if (column === null || local === null || typeof ResizeObserver === 'undefined') return
    const scrollport = scrollerOf(local)
    const composer = scrollport.querySelector<HTMLElement>('[data-composer-seat]')
    const observer = new ResizeObserver(() => { followRef.current?.() })
    observer.observe(column)
    if (composer !== null) observer.observe(composer)
    return () => { observer.disconnect() }
  }, [])

  // A failed/empty page leaves the head unchanged. Once the request leaves
  // its busy state there is no future prepend for the saved anchor to own.
  useEffect(() => {
    if (!loadingOlder) anchorRef.current = null
  }, [loadingOlder])

  const loadOlderAnchored = (): void => {
    const local = listRef.current
    /* v8 ignore next -- ref-null guard: the paging button renders inside the list tree. */
    if (local !== null) {
      const el = scrollerOf(local)
      const row = pagingAnchor(local, el)
      if (row !== null && row.dataset.chatAnchorKey !== undefined) {
        anchorRef.current = {
          key: row.dataset.chatAnchorKey,
          top: flowTop(row, el),
        }
      }
    }
    loadOlder()
  }

  return (
    <div className={css.root}>
      <div ref={listRef} className={css.scroll}>
        <div ref={columnRef} className={css.column} data-chat-flow="">
          {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
          {openState === 'error' && openError !== null && (
            <div className={css.openError}>
              {t('chat.loadError', { message: openError.message, code: openError.code })}
            </div>
          )}
          {/* Head controls: while loaded rows sit outside the window an
              instant local expand owns the head; only after the window
              reaches the loaded head does backend history paging show. */}
          {hiddenHeadRows > 0 ? (
            <div className={css.older}>
              <button type="button" onClick={expandWindow}>
                {t('chat.showEarlier', { count: Math.min(hiddenHeadRows, WINDOW_PAGE_ROWS) })}
              </button>
            </div>
          ) : hasMore && (
            <div className={css.older}>
              <button type="button" disabled={loadingOlder} onClick={loadOlderAnchored}>
                {loadingOlder ? t('loading') : t('chat.loadOlder')}
              </button>
            </div>
          )}
          {visibleKeys.map(nodeKey => (
            <ChatNodeSeat
              key={nodeKey}
              nodeKey={nodeKey}
              useSession={useSession}
              selectedCallId={selectedCallId}
              cwd={cwd}
              openFile={openFile}
              inspectCall={inspectCall}
              forkAt={forkAt}
              loadImage={loadImage}
              releaseImage={releaseImage}
              fileMentions={fileMentions}
              renderSlot={renderSlot}
              t={t}
            />
          ))}
          {/* No pending placeholders: questions (ui-user-questions) and approvals
              (ApprovalPanel) both take over the composer, so a flow card would
              double-render the same wait. */}
          {/* Turn-level loading signal: rides the whole running turn (first-token
              wait, tool execution, streaming) so it never flickers per step. */}
          {running && <TurnStatus startTime={runningTurnStart} t={t} />}
          {pendingSteering.map(item => (
            <PendingSteeringBubble
              key={item.id}
              content={item.content}
              loadImage={loadImage}
              releaseImage={releaseImage}
              t={t}
            />
          ))}
        </div>
        {!atBottom && (
          <div className={css.toBottomSlot}>
            <button
              type="button"
              className={css.toBottom}
              aria-label={t('chat.toBottom')}
              onClick={() => {
                const local = listRef.current
                /* v8 ignore next -- ref-null guard: the button only renders alongside the mounted list. */
                if (local !== null) toBottom(scrollerOf(local))
              }}
            >
              <IconChevronDownOutline14 />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
