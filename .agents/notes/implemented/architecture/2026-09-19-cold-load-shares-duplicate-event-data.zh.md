# Agent Note：冷加载共享字节相同的实体数据

Status: implemented

[English](2026-09-19-cold-load-shares-duplicate-event-data.md) | 中文

相关：[retry override 按值比较](2026-09-19-retry-override-structural-equality.md)——那篇阻止**写入侧**继续追加重复 header 快照；本篇在冷加载时折叠**磁盘上已有的**重复。两者互不取代。

## 问题

恢复会话时，整份持久化日志会被解析为互不相同的实体对象。重试循环产生的 `request/header` 快照彼此字节相同，却各自持有一份解析副本：实测一份解压后 288MB 的日志含 3225 条 header 事件，其中 3104 条与前一条完全相同，重试还使同一批 tool result 原样重复。全量物化该日志实测占 483MB 活堆，其中 344MB 是重复数据。上面的写入侧比较器修复只止住新增；已落盘的历史在每次恢复时仍会逐事件重新物化。

## 决策

`adoptStoredEvents()`——JSONL 与 SQLite 后端共用的独占式采纳路径——现在在 `data` 字节相同的事件之间共享同一个数据对象，键为 `JSON.stringify(data)` 的 SHA-256 摘要。映射只存摘要，键的内存开销与数据量无关。去重在遗留迁移之后执行（相同的新式事件迁移结果仍相同）、在 `adoptSessionEvent()` 之前执行；resume 路径经 `seedSource: 'persistence'`（`Session.fromRestore`）构造会话，原地冻结、不做拷贝，因此共享引用能存活到活动日志。取值不变：每个事件仍与其存储字节深相等，只是对象同一性收敛。深拷贝路径（`snapshotStoredEvents()`）刻意不动——它服务于有界尾窗，共享在那里无法回本。

## 验证

`packages/session/session-persistence/tests/persistence.spec.ts` 冷加载一份含两条字节相同 `request/header`、一条 `initial` header 与一条不同 header 的存储日志：相同对共享同一数据对象（`toBe`），另外两条保持独立对象，且四条全部与其存储字节深相等。对上述真实日志做强制 GC 实测：常驻 483MB → 139MB（−344MB，−71%），共享 7477 个数据对象，冷加载路径 +2.5s。仓库 typecheck、改动文件 oxlint 与完整 persistence 套件通过；该轮 SQLite 唯一失败用例是既有的环境性 symlink `EPERM`。

## 已否决的替代方案

**在 Session seed 物化内去重。** 否决：resume 路径已走 `seedSource: 'persistence'`（`fromRestore`，零拷贝），采纳层是 freshly parsed 图唯一存在的地方；seed 级 memo 还会作用于本就是分离副本的 replay/fork seed。

**在 JSONL 扫描器内哈希行后缀**（行后缀相同 ⇒ `data` 相同，免去 `JSON.stringify`）：推迟。它便宜约一个数量级，但需要经 `StoredPrefix` 传递摘要旁路；且计划中的窗口化冷加载将完全不再解析旧事件，stringify 成本与该优化都会失去意义。

**旧事件改存原始 JSON 字符串而非共享。** 否决：仅字符串就要留住实测日志约 288MB，且每次访问仍要付一次解析。

## 后果

恢复重复密集的日志以约 2.5s 的一次性哈希换取成比例更低的常驻内存（实测会话：483MB 中省 344MB）；解析瞬态峰值不变，因为后端在摘要前仍解析每一行。共享的数据对象与其余实体数据一样在 restore 边界冻结，任何消费者都观察不到别名。比较器修复之后写入的会话不含重复，resume 只付摘要一趟的成本。
