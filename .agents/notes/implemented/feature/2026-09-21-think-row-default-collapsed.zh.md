# Agent Note：Think 行按持久偏好默认折叠

Status: implemented

[English](2026-09-21-think-row-default-collapsed.md) | 中文

## Problem

实时推理 block 挂载时 Think 行是展开的，因为 `ReasoningRow` 用 `running` 作为 `expanded` 的初值，并把该状态一直保持到结算。于是已完成的 transcript 里每段思维链都是展开的：长推理链把真正的回答挤到页面下方，会话很难快速扫读。此前的跟尾滚动决策确实提供了折叠摘要供读者手动折叠后查看，但产品并没有提供任何让用户主动要求折叠行的入口——实时展开是当时唯一的行为。

## Decision

除非实时流拥有该行且持久偏好允许跟尾，否则 `ReasoningRow` 以折叠态打开：`useState(running && !defaultCollapsed)`，其中 `defaultCollapsed` 是普通 prop。折叠行保留既有的单行摘要——流式时显示最新行，结算后恢复首行——以及它的横向跟尾，因此默认折叠仍然能传达提供方的节奏。展开依旧显示完整推理正文，`AssistantMarkdown` 在两种形态下都不给 Think 行加行外装饰。

该偏好是持久用户设置，不是部署常量：`ui-conversation.thinkCollapsed`（布尔，`DEFAULT_THINK_COLLAPSED = true`）与 `busyEnter` 一起进入既有的 `ConversationSettingsSchema`，因此经 `~/.dsh/settings.yaml` 解析、随 DSH home 跨端口生效，并像其他 Web 偏好一样在手改文件后收敛。它通过 chat node 的注册方 hooks 舱室抵达渲染侧：`ComposerSubmissionPolicy` 把 `thinkCollapsed` 发布为 `SnapshotStore`，`CHAT_NODE_INJECT` 绑定它，生成的 `useThinkCollapsed` 座席把它送到 `AssistantNodeView` → `AssistantMarkdown` → `ReasoningRow`。设置页在 `composer-enter` 旁新增 `think-collapsed` 行。

由于浏览器 bundle 会在不重启 Host 的情况下重载，注册 schema 早于该字段的 Host 不会解析出它的值；因此 `adopt` 在 section 缺少 `thinkCollapsed` 时保留本地默认值，而不是采纳 `undefined`。

## Alternatives considered

**把硬编码的 `useState(running)` 直接改成 `useState(false)`。** 不予采纳：这会移除跟尾滚动决策所选择的实时展开，且无法恢复；同时把一处产品可见默认值写死，而该位置的取值本就因人而异。

**在 ui-conversation 插件上用 cordis.yml 的 `Config` 字段。** 不予采纳：这是必须存续于用户 DSH home 下的个人阅读偏好，而不是部署拓扑选择。配置字段改动需要重启 Host，也无法随 `settings.yaml` 迁移。

**继续把展开状态放在浏览器 `localStorage`。** 不予采纳，理由与外观、busy-Enter 偏好当初迁出时相同：按源隔离的存储会在换端口后丢失选择，尽管两个进程共享同一个 DSH home。

**只在结算后自动折叠。** 不予采纳：它仍然展开每一条实时思维链，而这正是该偏好要消除的阅读负担；并且会让行在轮次结束时跳动。

## Consequences

推理链不再把回答挤出屏幕，而摘要行仍然是实时节奏信号，因此跟尾滚动行为在折叠呈现中得以保留。该偏好持久且与端口无关；想恢复旧行为的用户选择「跟随流式展开」即可，按用户而非按部署生效。

接受两项代价。默认值改变了可见的 transcript 输出，因此本项发布后既有读者会看到折叠的 Think 行，摘要成为唯一仍在变化的提示。渲染路径也多了一个 prop 穿过三个组件外加一次 hook 绑定，这是把持久偏好经合规的注册方 hooks 舱室传递、而不是让呈现组件直接读取服务的代价。

## Testing

`packages/client/ui-conversation/tests/reasoning-row.client.spec.tsx` 固定默认折叠时保留实时摘要并可点击展开，覆盖流式与结算两种状态；既有的展开与结算用例在缺少 `thinkCollapsed` 时继续通过。`packages/client/ui-conversation/tests/submission-policy.client.spec.ts` 覆盖持久写入前的发布、从 scope 采纳，以及保留本地默认值的 schema 版本偏差场景。`packages/client/ui-conversation/tests/host.client.spec.ts` 固定 schema 注册、解析出的默认值，以及对非布尔值的拒绝。
