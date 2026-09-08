# `@deepseek-ai/dsh-llm-retry`

[English](README.md) | 中文

这是一个函数插件，通过 agent loop（智能体循环）在已关闭步骤触发的 `agent/request-error` waterfall（瀑布事件）中应用精确的提供方重试策略。它不包装 `ctx.llm.stream()`：每次适配器调用仍是一次提供方尝试，每次重试都会开启新的编号轮次。

每个提供方适配器都拥有可选的嵌套 `retryPolicy`；路由在 `ctx.llm` 上注册时会捕获该策略，并把它带到最终适配器边界。所有模型请求失败代码都会按配置的 `maxRetries` 预算重试（默认首次请求失败后再试两次）。normal mode 中旧的 `retryableCodes` 字段仍可解析以兼容已有配置，但不再用于过滤失败。normal 和 always 两种 mode 都有明确上限，默认采用从 500 ms 到 10 秒、带 10% jitter 的指数退避，并在成功、预算耗尽、取消或插件 dispose 时停止。

两种 mode 都使用带对称 jitter 的有界指数退避。有效的 `providerRetryAfterMs` 不超过 `maxDelayMs` 时会替换本地退避且不加 jitter；超过上限时会回退到配置的本地退避，而不会终止重试链。

等待前，插件会追加一条不进入表层的 `llm/retry` 事件，其中包含共享 `retryId`、提供方、mode、已解析策略的规范 key、失败、计划延迟和 `maxRetries`。浏览器安全的 `@deepseek-ai/dsh-llm-retry/types` 子路径导出该载荷，远程渲染器无需加载策略运行时即可读取持久状态。只有提供方与完整策略 key 相同的事件才会延续重试编号。等待结束时，插件会在返回 `{ kind: 'retry' }` 前追加带相同 `retryId`、轮次、步骤和重试编号的 `llm/retry-started`；退避期间取消则不会写 started 事件。取消和插件 dispose 会中止活跃退避，并等待活跃的委托恢复结算。

单独发布的 `./invariant` 配套模块会检查每个已调度重试是否指向当前开启轮次及其最新关闭步骤，是否与失败请求的持久提供方匹配，是否携带非空的提供方与策略标识，是否满足 mode 边界和 `maxRetries` 上限，是否拥有唯一步骤记录和正确的提供方策略重试编号，以及是否携带有界定时器延迟。它还要求每个 `llm/retry-started` 事件通过相同的 `retryId`、轮次、步骤与重试编号指向先前调度的尝试，并拒绝重复的 started 事件。full jitter 的下界可以是零毫秒。

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      maxRetries: 5
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2

- name: '@deepseek-ai/dsh-llm-retry'
```

执行器没有策略配置。`dsh-llm-pi-ai` 等多提供方适配器会把 `retryPolicy` 放在每个提供方 profile 内，避免维护第二份提供方名称列表。

## 模型体验

### 模型请求恢复

#### 模型看到的内容

模型不会看到重试事件、延迟、提供方错误或失败的部分输出。重试轮次会从持久表层历史中重建相同的显式提供方／模型请求，除非下游恢复策略有意更改该表层；失败分片绝不会进入派生消息。

#### Token 影响

每次重试都是新的提供方请求，可能重复计费输入 token。两种 mode 都会在配置的 `maxRetries` 预算耗尽时停止；`llm/retry` 自身不产生 token。

#### KV Cache 影响

重建请求保留之前的前缀，并可根据提供方规则复用 cache。非表层重试事件不会改变 cache 身份。

## 已知限制与暂缓事项

- **agent 轮次是唯一重试边界**：直接 `ctx.llm.stream()` 的消费方仍只尝试一次，因为原始流无法持久地区分各次尝试已经发出的分片。
- **永久性失败也会消耗有界预算**：身份验证、配额、无效请求、协议和无法恢复的上下文错误与其他失败一样重试，直到成功、预算耗尽、取消或 dispose；部署仍需负责提供方特定的成本与延迟控制。
- **有限插件预算可叠加**：本插件按确切提供方与完整已解析策略 key 计数；上下文溢出压缩（compaction）拥有独立预算。任何重叠策略都必须定义注册顺序行为。
- **恢复策略按 waterfall 顺序组合**：always mode 会先接受下游重试，再应用自己的回退。后续策略若忽略取消且永不结算，也会阻止回退、轮次停稳和插件 dispose 完成。
- **`llm/retry` 记录调度而非完成**：后续步骤与轮次事件用于确立成功、耗尽或取消。
