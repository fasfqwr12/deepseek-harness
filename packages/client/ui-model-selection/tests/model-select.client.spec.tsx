// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

function clearCapabilityStorage(): void {
  localStorage.clear()
}

describe('ModelSelect reasoning effort', () => {
  afterEach(clearCapabilityStorage)
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 自动（目录默认 High）',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual([
        '自动采用目录提供的安全默认 High。',
        'Off手动尝试此档位，结果以上游实际响应为准。',
        'Minimal手动尝试此档位，结果以上游实际响应为准。',
        'Low手动尝试此档位，结果以上游实际响应为准。',
        'Medium手动尝试此档位，结果以上游实际响应为准。',
        'High手动尝试此档位，结果以上游实际响应为准。',
        'XHigh手动尝试此档位，结果以上游实际响应为准。',
        'MaxLargest budget',
        'Ultra手动尝试此档位，结果以上游实际响应为准。',
      ])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        imageMode: 'auto',
        searchMode: 'auto',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('shows all four image and search modes and preserves the other session controls', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'xhigh',
        retryOverride: { maxRetries: 5, initialDelayMs: 2000 }, imageMode: 'native', searchMode: 'off',
      },
    }))
    const select = vi.fn(async (selection: ModelSelection) => { directory.set(state({ current: selection })); return true })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /图片处理/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      '自动目录明确支持图片时原生发送；明确不支持时走 Vision；未知时交给上游。',
      '模型原生不做本地转换，图片原样交给当前模型，上游错误直接显示。',
      'DSH 接管所有图片先由默认 Vision API 描述，再把文字交给当前模型。',
      '关闭本会话拒绝发送图片。',
    ])
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DSH 接管/ }))
    await waitFor(() => expect(select).toHaveBeenLastCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'xhigh',
      retryOverride: { maxRetries: 5, initialDelayMs: 2000 }, imageMode: 'dsh', searchMode: 'off',
    }))

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /联网搜索/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      '自动开放 DSH 搜索工具，由模型按需调用。',
      '模型原生不开放 DSH 搜索，交给上游模型自身的联网能力。',
      'DSH 接管开放 DSH web_search，使用默认搜索服务。',
      '关闭本会话禁用联网搜索。',
    ])
  })

  it('applies stored capability defaults once and never overwrites an explicit session choice', async () => {
    localStorage.setItem('dsh-capability-defaults/v2', JSON.stringify({ imageMode: 'dsh', searchMode: 'native' }))
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => { directory.set(state({ current: selection })); return true })
    const view = render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1))
    expect(select).toHaveBeenLastCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', imageMode: 'dsh', searchMode: 'native',
    })

    view.rerender(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    await Promise.resolve()
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('offers automatic plus all eight manual levels when the catalog has no default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 自动',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual([
        '自动没有安全能力元数据时不发送推理等级参数。',
        'Off手动尝试此档位，结果以上游实际响应为准。',
        'Minimal手动尝试此档位，结果以上游实际响应为准。',
        'Low手动尝试此档位，结果以上游实际响应为准。',
        'Medium手动尝试此档位，结果以上游实际响应为准。',
        'High手动尝试此档位，结果以上游实际响应为准。',
        'XHigh手动尝试此档位，结果以上游实际响应为准。',
        'Max手动尝试此档位，结果以上游实际响应为准。',
        'Ultra手动尝试此档位，结果以上游实际响应为准。',
        'Standard手动尝试此档位，结果以上游实际响应为准。',
      ])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 removed-model，推理等级 自动',
    })
    expect(trigger.textContent).toContain('removed-model')
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: /推理等级/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(within(screen.getByRole('menu')).queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
