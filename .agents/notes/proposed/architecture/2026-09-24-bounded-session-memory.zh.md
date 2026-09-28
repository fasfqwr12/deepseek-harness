# Agent Note：分层限制会话内存

Status: proposed

[English](2026-09-24-bounded-session-memory.md) | 中文

相关：[retry override 按值比较](../../implemented/bug-fix/2026-09-19-retry-override-structural-equality.md)——阻止新的重复 request header；[冷加载共享字节相同的实体数据](../../implemented/architecture/2026-09-19-cold-load-shares-duplicate-event-data.md)——恢复时折叠重复解析数据；[会话驻留窗口化](2026-09-19-windowed-session-residency.md)——拥有**后端**会话日志表示（stub、帧索引加载器、从 seq 0 折叠的消费者播种），面向实测 105MB 日志。

归属边界：那篇负责 host 进程如何持有会话日志；本篇负责它未覆盖的两层——Electron renderer 与浏览器侧客户端 runtime 窗口——以及已落地的重复 header 工作。下文凡涉及同一 105MB 验收目标的部分，一律从属于那篇，不再复述第二套窗口化设计；两者若有冲突，host 进程以后端那篇的目标为准，renderer 以本篇的上界为准。

## 问题

桌面壳先记录了 GPU 进程终止，随后记录 Chromium 渲染进程 `reason=oom`。Electron janitor 监控的是占用 3080 端口的进程，但真正终止的是 Chromium renderer，因此现有保护逻辑没有观察到失败进程。壳日志直接暴露了这个盲区：某次 OOM 前最后一拍记录 `backend WS 656MB (over 0/6)`——后端远未达到 1.2GB 阈值，而 renderer 内存从未被采样。同一份日志含三次 renderer OOM，且每一次后端自愈尝试都记录为 `deferred`（8/8），即日志中的内存事件从未被真正处理。

一次实测会话解压后为 318.9MB JSONL，其中 `request/header` 占 222.5MB（69.8%）；3380 个相邻 header 对中有 3301 个（97.7%）完全相同，3381 行只有 71 种完整 header。每条 header 都包含约 12KB system prompt 与 62 个工具 schema。

客户端已有 DOM 渲染窗口（`TAIL_WINDOW_ROWS = 60`）和每页 50 条消息的历史读取，但 `Session.loadOlder()` 会不断前插事件与 view，不会淘汰旧驻留数据。`ConversationAssembler` 也会为完整已加载窗口保留输入和派生 context。因此 DOM 虚拟化限制了挂载行数，却没有限制 JavaScript 对象图。

源码树已有写入侧结构比较器修复和冷加载数据共享修复，且二者都已进入桌面运行时实际加载的产物（各包的 `lib/index.js`，构建时间晚于修复源码）。此前内存行为只依据单个进程工作集推断，没有 renderer heap 与驻留窗口指标。

## 方案

在每个拥有内存的层次建立上界，不把 janitor 重启当作主要优化手段。

### 1. 激活并验证已有重复数据修复

两个修复已在运行时产物中生效；分文件的 `lib/types/` 产物早于源码，但各包 `main` 指向 `lib/index.js`，因此该陈旧产物不影响运行时。来自受影响会话的实时确认：重启后记录 3 条 header，相邻重复为 0；而此前记录的 3380 条 header 相邻重复率达 97.7%。

写入侧必须继续记录真实 header 变化，包括重试策略变化。读取侧必须保持深相等和回放语义，只共享相同 `data` 对象的身份。

### 2. 在桌面 janitor 中采样 renderer 内存

`main.js` 新增 `sampleProcessMetrics()`，读取 `app.getAppMetrics()` 并按进程类型报告最大工作集（`Tab` 即本壳的 renderer，另有 `GPU` 与 `Browser`）。janitor 在每 15 分钟一拍以及 `render-process-gone` 时调用并记录，使 renderer 高水位与崩溃原因被记录而非推断。

renderer 工作集连续 3 拍达到或超过 1.5GB 时，经现有 `rebuildWindow()` 路径重建窗口。该动作刻意区别于后端自愈：它只重建 renderer，后端与 JSONL 会话日志不受影响，因此不会丢正在跑的轮次。它复用后端自愈的「用户不在看」闸门，而不是另立一套更弱的策略。

已对真实 Electron 运行时验证：`type === 'Tab'` 与 `memory.workingSetSize` 均如假设存在，采样器能取到 renderer。

### 3. 保留 DOM 渲染窗口

保留现有 `ui-conversation` 渲染窗口和 `ui-trajectory` 虚拟化。不要通过挂载更多行或渲染整份 transcript 解决数据驻留问题。DOM 预算属于 presentation 层，不能代替会话内存预算。

### 4. 增加客户端事件驻留窗口

为 runtime Session 增加按大小和事件数计算的驻留窗口。打开会话时只加载尾页。被淘汰的范围仍可按 seq 重新读取，不能删除持久化数据。

预算只在实时追加路径上执行，因为那是唯一无需用户操作就会增长的方向：一个很长的流式 step 每个 chunk 累积一个 Match，实测某个会话就以这种方式持有 79,501 条 `assistant/chunk`、39,506 条 reasoning 和 14,406 条工具调用 chunk。`Session.evictOverBudget()` 依赖增量维护的 `residentSize`（序列化字符数），使检查在每次追加时只是两次比较；只有在越过预算时才回切窗口。

淘汰刻意不从 `loadOlder` 执行。读者刚请求的那一页正是当前最旧的驻留内容，在那里做预算回收会把刚取回的页丢掉、把 `baseSeq` 抬到它上面，使下一次向上翻页永远重复取同一段。翻页改为由它所读取的有限持久化历史约束；只有追加路径受预算约束。

切口绝不落在某个 Context 内部。assembler 只有在 start Match 到达后才发布 Context，因此丢掉 start 而保留其后的 Match 会留下一个永远无法渲染、却持续累积的无 start Context。`ConversationAssembler.evictionBoundary()` 返回不高于预算所要求切口的、最大的 Context 安全 seq：对每个跨越切口的 Context 把边界下移到它自己的 `startSeq`，直到没有 Context 跨越为止。被保留的一侧始终是实时尾部，因此运行中的 turn 永不淘汰。

淘汰作为一次整体操作更新原始 event/view 数组、base seq 与 `hasMore` 元数据以及 assembler 的索引，因此没有观察者会看到派生 Context 与事件不一致的窗口。抬高 `hasMore` 正是让被淘汰范围保持可达、而不是丢失的原因。

运行时不会为了渲染再保留一份完整窗口副本。派生行从有界事件窗口重建；窗口外状态仍使用紧凑的 summary 与 projection checkpoint。

### 5. 将 projection 播种作为冷窗口约定

进入和 resync 时，从持久化 checkpoint 与整值事件播种 projection，只对驻留尾窗 fold。旧 projection 状态由 checkpoint watermark 表示，不能在 renderer 或 host 重新 replay 完整日志。

持久化层应提供 seq 到字节/帧地址的定位信息。读取旧页时按需解码，不得先解析整个压缩会话。

### 6. 在保持回放能力的前提下去重 request header

在 `initial`、`resume` 和真实 `change` 边界保留规范完整快照。不要从持久化日志删除模型可见请求状态。发现未变化快照时，在所属层复用规范数据或引用已有 header 身份。任何新的磁盘引用格式都必须单独做格式决策和回放测试，本方案不静默引入兼容格式。

### 7. 增加 renderer 指标与兜底

在 open、翻页、淘汰和 `render-process-gone` 时记录 renderer 内存、驻留事件数、驻留字节数、projection 数量、挂载行数和 session id。使用 Electron 进程指标与 DevTools heap profile，在调整预算前先找到实际持有者。

janitor 保留为后端异常恢复机制，不作为日常内存管理算法。除非显式采集 renderer 指标，否则不能声称它保护了 renderer 内存。

## 实施跟踪

- [x] 验证构建产物包含 retry 结构比较和重复数据共享。两个修复已在运行时入口（`lib/index.js`，构建晚于修复源码）中；只有分文件的 `lib/types/` 产物陈旧，而包 `main` 不加载它。
- [x] 用实时数据确认写入侧修复：重启后 3 条 header，相邻重复 0；此前记录为 97.7%。
- [x] 对重复日志 fixture 运行 call-config 与 persistence 定向测试：两个套件共 115 项通过；客户端 runtime 的 session 与 assembler 套件 75 项通过。
- [x] 在桌面 janitor 的每一拍以及 `render-process-gone` 时采样 renderer/GPU/browser 工作集。
- [x] 增加 renderer 高水位阈值，只重建窗口，并复用后端自愈的「用户不在看」闸门。
- [x] 对真实 Electron 运行时验证采样器（确认 `Tab` renderer 类型与 `memory.workingSetSize`）。
- [x] 给客户端驻留窗口增加明确的事件数和大小预算（`RESIDENT_EVENT_BUDGET`/`RESIDENT_SIZE_BUDGET` 配合半上限回收余量；`Session.residentSize` 在全部五个写入点增量维护）。
- [x] 为 `Session.events`、`Session.views` 和 `ConversationAssembler` 索引实现安全淘汰（`Session.evictOverBudget()` + `ConversationAssembler.evictionBoundary()`，用一次 `replaceWindow` 从幸存者重建）。
- [x] 证明边界永不使某个 Context 的 start 变成孤儿：6 个 `evictionBoundary` 定向用例（含链式下移），加 4 个 Session 预算用例（大小预算淘汰、保留实时尾部、抬高 `hasMore`、预算内不淘汰）。两个客户端 runtime 套件共 85 项通过；客户端编译面类型检查干净。
- [ ] 保证前插、淘汰、重连和 resync 时滚动锚点稳定。对象层不持有读取位置（`chatScroll` 属于 presentation 层），因此 `ChatView` 基于索引的窗口（`windowStart`/`tailStart`）在 transcript 收缩时是否稳定，仍未被测试验证。
- [ ] 在会话生命周期边界增加 renderer 与 runtime 内存遥测。
- [ ] 为客户端窗口增加大型会话回归 fixture 和强制 GC 后的驻留内存测量。当前证据是单元级的预算记账，不是实测的驻留堆下降。
- [ ] 在不占用当前对话后端的受控重启后重建桌面 host，并验证 live GUI。
- [ ] 代码路径和测量结果改变后，同步更新相关 implemented Agent Note。
- host 进程的窗口化（stub、帧索引、从 seq 0 折叠的消费者播种）由[会话驻留窗口化](2026-09-19-windowed-session-residency.md)跟踪，不在本篇。

## 验收标准

本篇的目标是 renderer 与 client runtime 两层；host 进程的 105MB 日志驻留目标属于[会话驻留窗口化](2026-09-19-windowed-session-residency.md)。

- 桌面壳在每一拍 sweep 以及每次 `render-process-gone` 时记录 renderer、GPU、browser 工作集，使 renderer 增长趋势在演变为 OOM 之前可见。
- renderer 连续若干拍达到或超过高水位阈值时触发窗口重建，且后端进程与 JSONL 会话日志不受影响。
- 实时追加路径使客户端驻留事件数与大小保持在配置预算内，因此很长的流式 turn 无法让窗口无界增长。
- 向上翻页由它所读取的有限持久化历史约束，而非由驻留预算约束。反复上下翻页不会让窗口无界增长，但翻页超过预算的读者在会话 resync 前会持有超过预算的内容；这是为「向上翻页不会活锁」付出的刻意代价。
- 窗口化 projection 在每个测试 cut 上与全量 replay 的值和字节结果一致。
- 重试策略结构相等时，不再追加字节相同的 header。
- 冷加载共享字节相同的 event data，同时保持深相等和回放行为。
- 定向测试、typecheck、lint 和适用的 GUI/web replay 检查通过。

## 已考虑的替代方案

**只调 janitor 阈值。** 否决：janitor 监控的是 3080 后端，而现场失败的是 renderer OOM。重启后端不会限制 renderer 对象、DOM 工作、重复日志数据或 projection 索引。

**只增大 V8 或 Chromium 内存上限。** 否决：V8 将 heap 上限作为泄漏保护；增大上限只会延迟失败并可能增加 GC 停顿，不能使事件图有界。

**只在现有 janitor 中增加 renderer 采样。** 作为完整方案否决，作为第一步采纳：采样与只重建窗口使失败进程可观测并具备有界恢复，但它们发生在 renderer 已经膨胀之后，不会限制驻留事件图，因此客户端窗口工作仍然必需。

**只做 DOM 虚拟化。** 否决：产品已经有渲染窗口，但向上翻页仍会扩大 runtime event/view 数组和 assembler 索引。挂载行数不等于驻留数据大小。

**删除 request/header 事件。** 否决：request header 用于恢复模型可见请求状态和重试策略。应在保持回放的前提下去重或共享，不能删除。

## 风险

如果淘汰了 conversation node 仍需要的事件，可能破坏工具配对、位置、时间线或 projection 状态。已实现的边界规则只保证没有幸存 Context 丢失其 start Match；它尚未覆盖 tool call、turn、compaction summary、重连缺口和流式尾部等 cut，这些在本篇离开 proposal 状态前仍然必需。Location 与 timeline 索引由同一次 `replaceWindow` 重建重新派生，但该等价性目前是按构造保证，而非由测试断言。

翻页超过预算的部分不受驻留预算约束。在很大的会话中一路向上翻页的读者会保留其请求过的每一页，直到 resync 或某次实时追加在一个已经变大的窗口上触发预算回收。要在不淘汰读者刚请求那一页的前提下限制翻页，需要一个对象层当前并不持有的读取位置信号。

大小预算可能导致超大单事件更频繁地触发读取。单个大于整个预算的事件会被保留驻留而不是丢弃，因此一个超大事件可能使窗口长期高于预算。

renderer 遥测增加少量诊断元数据，但不能持久化完整消息体、prompt、工具 schema、凭据或附件。

参考：

- [Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Chromium OOM 调查](https://chromium.googlesource.com/chromium/src/+/main/docs/memory/oom.md)
- [Chromium 内存文档](https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/memory/README.md)
- [V8 heap 上限](https://v8.dev/blog/heap-size-limit)
- [Electron RenderProcessGoneDetails](https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details)

## 后果

系统会增加显式的 seq/帧定位元数据；用户深入旧历史时可能触发更多按需读取。换来的结果是 persistence、runtime state 和 DOM rendering 各自拥有可测试的内存上界，同时保留回放正确性和模型可见历史。

在客户端驻留窗口、构建产物验证、遥测和大型会话验收完成并评审前，本记录保持 proposed 状态。
