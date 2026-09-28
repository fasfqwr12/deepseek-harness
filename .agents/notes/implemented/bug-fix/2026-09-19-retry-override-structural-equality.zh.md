# Agent Note: 重试覆盖值按值比较，而非按引用

Status: implemented

[English](2026-09-19-retry-override-structural-equality.md) | 中文

相关：[冷加载共享字节相同的实体数据](../architecture/2026-09-19-cold-load-shares-duplicate-event-data.zh.md)——本篇阻止**写入侧**继续追加重复 header 快照；那篇在冷加载时折叠**磁盘上已有的**重复。两者互不取代。

## Problem

`callConfigEquals()` 是「请求头是否真的变了」的逐字段判定器，日志中的 `request/header` 快照由它决定是否追加：只要 `headerEquals()` 判定有差异，agent loop 就会追加一份完整头部——调用配置、渲染后的系统提示词、以及全部已装配的工具 schema。它对 `retryOverride` 字段用的是 `!==`，而该字段类型是 `'off' | { maxRetries?, initialDelayMs? }` 联合体。对原始值形式这是对的，对对象形式是错的：会话级重试策略每次请求都会重新构造，两个结构相同的策略永远不是同一个引用，于是判定器每一步都报告「变了」。loop 随之每步追加一份约 63KB 的头部快照。实测某会话共 3073 条头部事件，其中 3003 条（97.8%）与前一条逐字节相同——占该会话 277.2MB 解压日志中的 200.9MB（72%），也占常驻会话事件数组中同样的比例。只有设置了会话级重试覆盖的部署会命中；未设置时该字段缺失，引用比较恰好正确。

## Decision

`call-config.ts` 增加模块私有的 `retryOverrideEquals(a, b)`：两侧都是对象时逐字段比较 `maxRetries` 与 `initialDelayMs`，否则回退到 `!==`——对 `'off'`、对 `undefined`、以及「对象对原始值」的混合情形，`!==` 都是精确的。`callConfigEquals()` 用它取代原先的引用比较；`LlmCallConfig` 其余字段本来就是原始值或已逐元素比较（`stop`）。

## Verification

`packages/llm/llm/tests/call-config.spec.ts` 覆盖两种形式与混合情形：同一策略的不同实例判为相等，`'off'` 与 `'off'` 判为相等，`maxRetries` 或 `initialDelayMs` 不同判为不等，对象永不等于 `'off'` 或缺省。另外用从真实会话日志中抽取的两组 `request/header` 跑了判定器：逐字节相同的一组现在判为未变（修复前判为已变），而配置与系统提示词确实不同的那一组仍判为已变。构建产物 `lib/` 在 host 面重新构建前仍保留修复前行为，这正是能在同一份数据上观察到前后差异的原因。

## Alternatives considered

**比较两者的 `JSON.stringify`。** 否决：在请求路径上每次比较都要分配字符串，且判定结果会依赖键的插入顺序。

**整个函数换成通用深比较。** 否决：`callConfigEquals` 的职责是按名字逐字段比较，通用深比较会悄悄开始比较那些刻意保持原始值或按引用比较的字段，同时无法告诉调用方是哪个字段变了。

**把 `retryOverride` 从记录的头部中移除。** 否决：重试策略是影响模型行为的会话状态，`llm-retry` 在恢复时要读回它，移除会破坏「日志可重建请求」这条规则。

**不改判定器，改为在写日志处加去重护栏。** 暂缓：再加一层保险是值得的，但缺陷在判定器；护栏会让 `callConfigEquals` 的其他调用方继续报告幻影变化。

## Consequences

会话只在请求头真正变化时记录一份头部快照，而不是每步一份。已经在磁盘上的会话仍保留其重复快照：本次修复止住增长，不重写历史，那些事件占用的常驻数组也只对新会话收缩。会话级重试覆盖仍可从日志完整重建，恢复行为不变。
