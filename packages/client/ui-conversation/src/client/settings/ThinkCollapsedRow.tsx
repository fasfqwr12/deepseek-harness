/** General Settings row for the Think-row default disclosure preference. */
import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationKey } from '../locales.ts'
import css from './EnterBehaviorRow.module.css'

/** Registration-side preference face. */
export interface ThinkCollapsedRowInjected {
  hooks: {
    /** Persisted Think disclosure preference bound as useThinkCollapsed. */
    thinkCollapsed: SnapshotStore<boolean>
  }
  /** Change whether Think rows start collapsed. */
  setThinkCollapsed: (collapsed: boolean) => void
}

/** Full Settings-row props. */
export type ThinkCollapsedRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<ThinkCollapsedRowInjected>

const OPTIONS: readonly {
  id: string
  collapsed: boolean
  label: ConversationKey
}[] = [
  { id: 'collapsed', collapsed: true, label: 'settings.think.on' },
  { id: 'stream', collapsed: false, label: 'settings.think.off' },
]

/**
 * Render the Think-row disclosure preference selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function ThinkCollapsedRow({ useThinkCollapsed, setThinkCollapsed, t }: ThinkCollapsedRowProps) {
  const collapsed = useThinkCollapsed(value => value)
  const [open, setOpen] = useState(false)
  const selectedLabel: ConversationKey = collapsed ? 'settings.think.on' : 'settings.think.off'

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.think.title')}</div>
        <div className={css.desc}>{t('settings.think.description')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={collapsed ? 'collapsed' : 'stream'}
        onSelect={(id) => {
          setOpen(false)
          setThinkCollapsed(id === 'collapsed')
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}
          >
            {t(selectedLabel)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
