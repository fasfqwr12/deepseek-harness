# Agent Note: 提供方带有可持久化的启用开关

Status: implemented

[English](2026-09-21-provider-enabled-switch.md) | 中文

## Problem

一条已配置的提供方路由过去只有两种状态：已配置，和已删除。`providers`（pi-ai）或 `llm-deepseek` 分节里的每个 profile 都会注册一条路由，因此用户不想要其模型出现在选择器里的提供方——为一个历史模型保留的网关、配额已耗尽的网关、若干可互换网关中的一个——只能被删除。删除会把整个 profile 一并带走：端点、catalog，以及必须重新派生才能加回来的那条凭据引用。Models 页面只提供「编辑」和「删除」，两者之间什么都没有，而模型选择器会列出每一条已注册的路由。

## Decision

profile 携带 `enabled`（布尔，默认 `true`）。解析会把这个字段保留在解析后的 profile 上，因此 `ResolvedPiAiProviderProfile.enabled` 与 `DeepSeekConnectionOptions.enabled` 就是消费方询问一条路由是否在服务的唯一位置。有两个消费方读取它：

- **注册。** `llm-pi-ai` 把它注册的路由集合过滤为已启用的 profile——即 `servingRoutes(profiles())`，同时 `registrationFacts` 现在也排除已停用的 profile，因为注册表在注册时捕获路由，而一个永不变化的 fact 会让该路由继续服务。`llm-deepseek` 只拥有一条固定路由，因此它注册空集合而不是跳过注册：句柄必须存在，日后重新启用才能 `replace` 回来。
- **可配置提供方目录。** 已停用的 profile 仍然列出。注册表把它们报为 `active: false`，这正是它们在 Models 页面仍可编辑的原因——从目录中消失的路由将永远无法被重新启用。

于是，被停用的路由经由既有机制退出所有模型选择器：`buildModelCatalog` 遍历 `ctx.llm.listProviders()`，因此未注册的路由不贡献任何分组，而选择器对 `llm/adapters-updated` 的订阅会让它无需刷新页面就更新。

Models 页面为每一行已配置的提供方渲染一个**启用开关**，读取解析后的分节而非用户层——在组合 base 中被停用的提供方，不应仅因用户层沉默就显示为启用。启用时**取消**该字段而不是写入 `true`：schema 默认值本就意味着启用，而存下的 `true` 会在组合 base 日后禁用该路由时把它钉在启用状态。该写入是一条路径 op，因此绝不重建分节；被拒绝时会在该行上显示，而不是让开关静默回弹。

## Alternatives considered

**删除提供方、需要时再加回来。** 否决：这会摧毁端点、模型列表与派生出的凭据引用。而 profile 恰恰是用户想保留的那份状态。

**保持路由注册，只在选择器里过滤掉。** 否决：该路由仍会响应请求，因此被停用的提供方对任何点名它的调用方依然可达——包括会话中已存下的选择。注册才是决定一条路由是否服务的唯一位置。

**在插件配置里另设一份「已停用提供方」清单。** 否决：它把一个提供方的状态拆到两份可能互相矛盾的文档里，而 profile 已经拥有该路由的全部其他事实。

**重新启用时写入 `enabled: true`。** 否决：它把默认值变成了覆盖，于是日后在组合 base 中禁用该路由的部署会发现用户层在悄悄把它重新启用。

## Consequences

把某个 namespace 的所有路由都停用后，适配器仍以零路由注册，这是 `AdapterRegistrationHandle.replace` 明确允许的。`llm-deepseek` 经由那条同时承载其重试策略的 `replace` 调用抵达该状态，因此关闭一条路由仍是一个原子的注册表区段：`llm/adapters-updated` 的观察者只会看到该路由离开一次，绝不会有两次注册之间的空注册表窗口。

该开关是提供方级而非模型级。profile 的 `models` 列表可以收窄一条路由所服务的内容，但没有按模型的启停，想要隐藏某个模型的用户只能把它从列表中移除。

`pnpm run typecheck`、`packages/llm/llm-pi-ai`、`packages/llm/llm-deepseek` 与 `packages/client/ui-settings-models` 锁定该行为：pi-ai 测试套件通过 settings 针对 mock 服务器把一条路由关掉再打开，断言停用期间请求以 `NO_ADAPTER` 失败、重新启用后重新开始流式输出；deepseek 套件经由 `llm/adapters-updated` 锁定同样的事实，包括没有任何观察者会看到空注册表；客户端套件锁定渲染出的状态、两个方向各自写入的 `set`/`unset` op、未配置行与只读行上的禁用开关，以及行上的失败消息。
