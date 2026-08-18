/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useMemo, useRef, useState, useSyncExternalStore,
  type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Desktop-wide manual choices. Catalog metadata annotates them but never removes them. */
const MANUAL_EFFORTS = [
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
] as const

/** Which pane the dropdown shows: the root rows or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort' | 'retry' | 'image' | 'search'

type CapabilityMode = NonNullable<ModelSelection['imageMode']>

const CAPABILITY_MODES: readonly CapabilityMode[] = ['auto', 'native', 'dsh', 'off']

const CAPABILITY_DEFAULTS_KEY = 'dsh-capability-defaults/v2'

/** Read only non-sensitive defaults written by dsh-vision-settings. */
function readCapabilityDefaults(): { imageMode: CapabilityMode; searchMode: CapabilityMode } {
  const fallback = { imageMode: 'auto' as const, searchMode: 'auto' as const }
  try {
    const parsed = JSON.parse(localStorage.getItem(CAPABILITY_DEFAULTS_KEY) ?? '{}') as Record<string, unknown>
    const valid = new Set<unknown>(CAPABILITY_MODES)
    return {
      imageMode: valid.has(parsed.imageMode) ? parsed.imageMode as CapabilityMode : fallback.imageMode,
      searchMode: valid.has(parsed.searchMode) ? parsed.searchMode as CapabilityMode : fallback.searchMode,
    }
  } catch {
    return fallback
  }
}

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** One dynamic retry row; undefined means preserve the provider retry policy. */
interface RetryChoice {
  key: string
  override: ModelSelection['retryOverride']
  label: string
  description?: string
}

/** 字段级比较两个重试覆盖（undefined/'off' 直比，对象比数值）。 */
function sameRetry(a: ModelSelection['retryOverride'], b: ModelSelection['retryOverride']): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return a.maxRetries === b.maxRetries && a.initialDelayMs === b.initialDelayMs
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const defaultsAppliedRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: { provider: group.id, model: model.id } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const selectedEffort = state.current?.reasoningEffort
  const declaredById = useMemo(() => new Map(
    (reasoning?.efforts ?? []).map((effort: ModelReasoningEffort) => [effort.id, effort]),
  ), [reasoning])
  const automaticDefault = reasoning?.defaultEffort
  const automaticDefaultLabel = automaticDefault === undefined
    ? undefined
    : declaredById.get(automaticDefault)?.name ?? automaticDefault
  const effortLabel = selectedEffort === undefined
    ? automaticDefaultLabel === undefined
      ? t('effort.auto')
      : t('effort.autoWithDefault', { effort: automaticDefaultLabel })
    : declaredById.get(selectedEffort)?.name
      ?? MANUAL_EFFORTS.find(level => level.id === selectedEffort)?.label
      ?? selectedEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => {
    const standardIds = new Set(MANUAL_EFFORTS.map(level => level.id))
    const custom = (reasoning?.efforts ?? []).filter(level => !standardIds.has(level.id as typeof MANUAL_EFFORTS[number]['id']))
    return [
      {
        key: 'automatic',
        effort: undefined,
        label: t('effort.auto'),
        description: automaticDefaultLabel === undefined
          ? t('effort.autoDescription')
          : t('effort.autoDefaultDescription', { effort: automaticDefaultLabel }),
      },
      ...MANUAL_EFFORTS.map((level) => {
        const declared = declaredById.get(level.id)
        return {
          key: `effort:${level.id}`,
          effort: level.id,
          label: declared?.name ?? level.label,
          description: declared?.description ?? t('effort.manualDescription'),
        }
      }),
      ...custom.map(level => ({
        key: `effort:${level.id}`,
        effort: level.id,
        label: level.name,
        description: level.description ?? t('effort.manualDescription'),
      })),
    ]
  }, [automaticDefaultLabel, declaredById, reasoning, t])
  // 重试预设：默认/关闭/三档覆盖（次数 × 起始间隔），与 llm-retry 的覆盖字段对应
  const retryChoices = useMemo<readonly RetryChoice[]>(() => [
    { key: 'retry:default', override: undefined, label: t('retry.providerDefault') },
    { key: 'retry:off', override: 'off', label: t('retry.off') },
    { key: 'retry:3x1s', override: { maxRetries: 3, initialDelayMs: 1000 }, label: t('retry.option', { count: 3, delay: 1 }) },
    { key: 'retry:5x2s', override: { maxRetries: 5, initialDelayMs: 2000 }, label: t('retry.option', { count: 5, delay: 2 }) },
    { key: 'retry:8x3s', override: { maxRetries: 8, initialDelayMs: 3000 }, label: t('retry.option', { count: 8, delay: 3 }) },
  ], [t])
  // 自定义表单的本地草稿状态（次数 / 间隔秒）
  const [customCount, setCustomCount] = useState<number>(5)
  const [customDelay, setCustomDelay] = useState<number>(2)
  const currentRetry = state.current?.retryOverride
  const isCustomActive = currentRetry !== undefined && currentRetry !== 'off'
    && !retryChoices.some(c => sameRetry(c.override, currentRetry))
  const customValid = customCount >= 0 && customCount <= 20 && customDelay >= 0.1 && customDelay <= 60
  const applyCustom = (): void => {
    if (!customValid) return
    chooseRetry({ maxRetries: Math.round(customCount), initialDelayMs: Math.round(customDelay * 1000) })
  }
  const retryLabel = currentRetry === undefined
    ? t('retry.providerDefault')
    : currentRetry === 'off'
      ? t('retry.off')
      : t('retry.option', {
        count: currentRetry.maxRetries ?? 0,
        delay: (currentRetry.initialDelayMs ?? 0) / 1000,
      })
  const imageMode = state.current?.imageMode ?? 'auto'
  const searchMode = state.current?.searchMode ?? 'auto'
  const capabilityLabel = (mode: CapabilityMode): string => t(`capability.${mode}` as 'capability.auto')
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  // Defaults seed only fields the Host has not selected yet. Existing user
  // choices always win, including later changes made from the model menu.
  useEffect(() => {
    if (state.status !== 'ready' || state.current === null) return
    if (state.current.imageMode !== undefined && state.current.searchMode !== undefined) return
    const identity = state.current.provider + '\u0000' + state.current.model
    if (defaultsAppliedRef.current === identity) return
    defaultsAppliedRef.current = identity
    const defaults = readCapabilityDefaults()
    lastActionRef.current = 'select'
    void select({
      provider: state.current.provider,
      model: state.current.model,
      ...state.current.reasoningEffort === undefined ? {} : { reasoningEffort: state.current.reasoningEffort },
      ...state.current.retryOverride === undefined ? {} : { retryOverride: state.current.retryOverride },
      imageMode: state.current.imageMode ?? defaults.imageMode,
      searchMode: state.current.searchMode ?? defaults.searchMode,
    }).then((accepted) => {
      if (!accepted) defaultsAppliedRef.current = null
    })
  }, [select, state.current, state.status])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  if (!available) return null

  const show = (): void => {
    setPane('root')
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    // 切换模型时携带会话已设置的重试覆盖，避免切换即丢失
    const carrying: ModelSelection = {
      ...selection,
      ...state.current?.retryOverride === undefined ? {} : { retryOverride: state.current.retryOverride },
      ...state.current?.imageMode === undefined ? {} : { imageMode: state.current.imageMode },
      ...state.current?.searchMode === undefined ? {} : { searchMode: state.current.searchMode },
    }
    lastActionRef.current = 'select'
    void select(carrying).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (selectedEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
      ...state.current.retryOverride === undefined ? {} : { retryOverride: state.current.retryOverride },
      ...state.current.imageMode === undefined ? {} : { imageMode: state.current.imageMode },
      ...state.current.searchMode === undefined ? {} : { searchMode: state.current.searchMode },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseRetry = (override: ModelSelection['retryOverride']): void => {
    if (state.current === null) return
    if (sameRetry(state.current.retryOverride, override)) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...state.current.reasoningEffort === undefined ? {} : { reasoningEffort: state.current.reasoningEffort },
      ...override === undefined ? {} : { retryOverride: override },
      ...state.current.imageMode === undefined ? {} : { imageMode: state.current.imageMode },
      ...state.current.searchMode === undefined ? {} : { searchMode: state.current.searchMode },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseCapability = (kind: 'image' | 'search', mode: CapabilityMode): void => {
    if (state.current === null) return
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...state.current.reasoningEffort === undefined ? {} : { reasoningEffort: state.current.reasoningEffort },
      ...state.current.retryOverride === undefined ? {} : { retryOverride: state.current.retryOverride },
      ...(kind === 'image' ? { imageMode: mode, searchMode } : { imageMode, searchMode: mode }),
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? state.current?.model ?? t('trigger.fallback')
  const triggerLabel = state.current === null ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = currentChoice === undefined
    ? state.current === null
      ? t('trigger.selectAria')
      : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
    : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => {
          if (open) {
            close()
          } else {
            show()
          }
        }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        {state.current !== null && <span className={css.triggerEffort}>{effortLabel}</span>}
        <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} />
      </button>

      {open && (
        <div
          id={`${id}-menu`}
          className={css.menu}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('model') }}>
                <span className={css.cellLabel}>{t('menu.model')}</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              {state.current !== null && (
                <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('effort') }}>
                  <span className={css.cellLabel}>{t('menu.effort')}</span>
                  <span className={css.cellValue}>{effortLabel}</span>
                  <IconChevronRightOutline14 className={css.cellChevron} />
                </button>
              )}
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('retry') }}>
                <span className={css.cellLabel}>{t('menu.retry')}</span>
                <span className={css.cellValue}>{retryLabel}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('image') }}>
                <span className={css.cellLabel}>{t('menu.image')}</span>
                <span className={css.cellValue}>{capabilityLabel(imageMode)}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
              <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { setPane('search') }}>
                <span className={css.cellLabel}>{t('menu.search')}</span>
                <span className={css.cellValue}>{capabilityLabel(searchMode)}</span>
                <IconChevronRightOutline14 className={css.cellChevron} />
              </button>
            </>
          )}

          {pane === 'model' && (
            <>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {state.groups.map((group) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                      <div className={css.groupTitle} id={headingId}>{group.name}</div>
                      {group.models.map((model) => {
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            className={clsx(css.option, selected && css.selected)}
                            key={model.id}
                            title={model.name}
                            disabled={busy}
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{model.name}</span>
                              {model.description !== undefined && (
                                <span className={css.description}>{model.description}</span>
                              )}
                            </span>
                            <span className={css.check}>
                              {selected ? <IconCheckOutline16 /> : null}
                            </span>
                          </button>
                        )
                      })}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.map(level => (
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedEffort === level.effort}
                  className={clsx(css.option, selectedEffort === level.effort && css.selected)}
                  key={level.key}
                  disabled={false}
                  onClick={() => { chooseEffort(level.effort) }}
                >
                  <span className={css.optionCopy}>
                    <span className={css.modelName}>{level.label}</span>
                    {level.description !== undefined && (
                      <span className={css.description}>{level.description}</span>
                    )}
                  </span>
                  <span className={css.check}>
                    {selectedEffort === level.effort ? <IconCheckOutline16 /> : null}
                  </span>
                </button>
              ))}
            </>
          )}
          {pane === 'retry' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {retryChoices.map(choice => (
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sameRetry(currentRetry, choice.override)}
                  className={clsx(css.option, sameRetry(currentRetry, choice.override) && css.selected)}
                  key={choice.key}
                  disabled={busy}
                  onClick={() => { chooseRetry(choice.override) }}
                >
                  <span className={css.optionCopy}>
                    <span className={css.modelName}>{choice.label}</span>
                    {choice.description !== undefined && (
                      <span className={css.description}>{choice.description}</span>
                    )}
                  </span>
                  <span className={css.check}>
                    {sameRetry(currentRetry, choice.override) ? <IconCheckOutline16 /> : null}
                  </span>
                </button>
              ))}
              <button
                ref={itemRef()}
                type="button"
                role="menuitemradio"
                aria-checked={isCustomActive}
                className={clsx(css.option, isCustomActive && css.selected)}
                key="retry:custom"
                disabled={busy}
                onClick={() => { applyCustom() }}
              >
                <span className={css.optionCopy}>
                  <span className={css.modelName}>
                    {t('retry.custom')}
                    {isCustomActive && currentRetry !== undefined && typeof currentRetry === 'object'
                      ? ` · ${t('retry.customSummary', { count: currentRetry.maxRetries ?? 0, delay: (currentRetry.initialDelayMs ?? 0) / 1000 })}`
                      : ''}
                  </span>
                </span>
                <span className={css.check}>
                  {isCustomActive ? <IconCheckOutline16 /> : null}
                </span>
              </button>
              <div className={css.customRow}>
                <label className={css.customField}>
                  <span className={css.customLabel}>{t('retry.count')}</span>
                  <input
                    className={css.customInput}
                    type="number"
                    min={0}
                    max={20}
                    step={1}
                    value={customCount}
                    disabled={busy}
                    onChange={(e) => { setCustomCount(Number(e.target.value)) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom() } }}
                  />
                </label>
                <label className={css.customField}>
                  <span className={css.customLabel}>{t('retry.interval')}</span>
                  <input
                    className={css.customInput}
                    type="number"
                    min={0.1}
                    max={60}
                    step={0.1}
                    value={customDelay}
                    disabled={busy}
                    onChange={(e) => { setCustomDelay(Number(e.target.value)) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom() } }}
                  />
                </label>
                <button
                  type="button"
                  className={css.customApply}
                  disabled={busy || !customValid}
                  onClick={() => { applyCustom() }}
                >
                  {t('retry.apply')}
                </button>
              </div>
              {!customValid && (
                <div className={css.customHint}>{t('retry.invalid')}</div>
              )}
            </>
          )}
          {(pane === 'image' || pane === 'search') && CAPABILITY_MODES.map((mode) => {
            const current = pane === 'image' ? imageMode : searchMode
            return (
              <button
                ref={itemRef()}
                type="button"
                role="menuitemradio"
                aria-checked={current === mode}
                className={clsx(css.option, current === mode && css.selected)}
                key={`${pane}:${mode}`}
                disabled={busy}
                onClick={() => { chooseCapability(pane, mode) }}
              >
                <span className={css.optionCopy}>
                  <span className={css.modelName}>{capabilityLabel(mode)}</span>
                  <span className={css.description}>{t(`capability.${pane}.${mode}` as 'capability.image.auto')}</span>
                </span>
                <span className={css.check}>{current === mode ? <IconCheckOutline16 /> : null}</span>
              </button>
            )
          })}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
