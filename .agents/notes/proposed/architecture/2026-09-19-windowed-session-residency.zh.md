# Agent Note：会话常驻滑动窗

Status: proposed

[English](2026-09-19-windowed-session-residency.md) | 中文

相关：[冷加载共享字节相同的实体数据](../architecture/2026-09-19-cold-load-shares-duplicate-event-data.md)——已落地；本提议在其上构建常驻内存的终局方案。

## 问题

冷加载去重落地后，恢复实测的 105MB 日志常驻 139MB（自 483MB 降下）。剩余成本是实体事件数组本身：13.1 万个事件对象全部常驻，因为 `Session.log` 就是整份日志（`seq === log.length`），而且多个在用插件在每次进程重启后从 seq 0 重折整份日志——token-meter 的 `ReplayState` 恒以 `consumedEvents: 0` 起步并读取每个事件的 `data`；同样的 fold-from-0 形态在 telemetry/stats/title 消费者中反复出现。这些折叠使整份日志在每次 resume 后实际处于「热」状态，所以只窗口化数组到不了 50MB 目标：每个 fold-from-0 消费者都会把窗口外事件重新物化一遍。

## Proposal

**阶段一——消费者播种（逐个独立可发）。** 把每个 fold-from-0 消费者迁移到已存在的播种源：token-meter 用自己的已检查点投影（`tokenUsage` 的 totals/last、`contextPressure.surfaceTokens`）加上 `session.deriveMessages()` 与 `session.requestHeader()`——两者都被存活 surface 限界——以 O(surface) 重估一次，替代每次重启 O(log)。其余消费者逐案同型迁移。每次迁移都是今天的冷启动 CPU 收益，同时也是窗口化的前置。

**阶段二——窗口化日志表示。** `Session.fromRestore` 增加 `windowStart`：低于它的 seed 条目是冻结的惰性 stub（`{type, seq, time}` + 由按会话 loader 支撑、带 LRU 的 `data` getter）；不低于它的是如今的完整事件。`seq === log.length` 不变；`SurfaceManager` 用 `{nodes, replaceGeneration}` 播种（由新导出的 `foldSurfaceState(events)` 计算——surface 折叠状态恰好就这两个字段），因此没有重放会触碰 stub；`requestHeader`/`requestContext` 的折叠位置从 `windowStart` 起步，以整值 last-wins 播种（正常情况下最后一条 header/context 就在窗口内；其余情况一次偏移读取兜底）。

**阶段三——帧索引 loader。** JSONL 后端在现有扫描中记录每个 zstd 帧的 seq 区间，用帧内 `fs.readSync` 偏移解码单帧（约 0.1ms）实现 `(seq) => SessionEvent`；内存索引约每会话 2MB。

## Alternatives considered

**基于 Proxy 的 `events`。** 否决：迭代（`[...events]`）会静默物化一切；stub 保持朴素的冻结数组语义。

**只锚定压缩点、无 stub 的窗口。** 否决：存活节点会回溯到上次压缩之前，而 `events[seq]` 随机访问（token-meter 水印、telemetry 身份检查——18 处 src）要求旧 seq 可解析。

## Acceptance criteria

恢复实测的 105MB 日志常驻低于 50MB；窗口化折叠产生的 surface 状态与完整重放一致；已迁移的消费者从各自检查点起步而非从 seq 0 折叠；既有冷加载、持久化与投影测试套件保持通过。

## Risks

每个窗口外事件都必须仍能经 `events[seq]` 解析，因此消费者若绕开 stub 加载路径，只会再次静默物化整份日志而不会报错。阶段一迁移的是已知的 fold-from-0 消费者，但未被转换的消费者会重新引入该成本，且除内存外没有可见症状。帧索引假定 JSONL 扫描既有的帧边界仍然权威。

## Consequences

三阶段完成后，恢复实测日志只持有 stub（约 10MB）+ 常驻窗口（锚定最后压缩点、模型上下文量级）+ 帧索引（约 2MB）——低于 50MB 目标。阶段一迁移掉的每个消费者都不再有 fold-from-0 CPU。合法需要遍历整份日志的消费者按序解码帧，工作量以今天 `loadStored` 已付的成本为界。
