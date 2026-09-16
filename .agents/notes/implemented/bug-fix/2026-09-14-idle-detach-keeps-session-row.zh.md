# Agent Note：空闲自动分离保留客户端会话行

Status: implemented

[English](2026-09-14-idle-detach-keeps-session-row.md) | 中文

## 问题

空闲自动分离清扫（默认 30 分钟，随冷历史尾窗一起引入）会释放超过间隔无追加事件的会话所属 agent 句柄。释放将 会话 从内存 store 移除——这是设计使然：日志仍在持久化中，下次交互透明恢复。但 store 在移除时发出 `session/disposed`，host 事件流把它转发为 `host/session-removed`，客户端随即删除侧边栏行。透明恢复的承诺由此失去入口：行没了，就没有可点击的对象。用户在切换工作区时看到会话从列表消失（闲置超过间隔的那些），刷新页面又会回来——因为 `session.list` 基线会从持久化合并冷会话。刷新能恢复这一不对称性证明数据从未丢失，丢的只是客户端的行。

## 决策

清扫在 ApiProxy apply 闭包持有的 `idleDetached` 集合中标记每个由它发起释放的会话。host 流的 `session/disposed` 监听器查询该集合，对被标记会话抑制 `host/session-removed` 帧；释放 promise 落定后标记清除，同一会话 id 之后发生的真实释放仍会通知。抑制只作用于空闲清扫：其他所有 `session/disposed` 来源（fiber 卸载、teardown 路径）保持移除帧，真实删除对客户端依然可见。

## 验证

`api-proxy-cold.spec.ts` 的空闲自动分离套件新增回归：real-dispose 台架（会话生命周期按 `prepare`/`enter`/`announce` 折叠并保留 detach 能力，句柄释放经 store 触发真实的 `session/disposed`）下，清扫的分离不产生 host 帧——证明方式是静默清扫后观察到的第一帧是未标记手工释放的 `host/session-removed`，而非被分离会话的。apiproxy 全套件通过（389 项测试）。

## 考虑过的替代方案

**客户端收到每个 `host/session-removed` 时回查持久化。** 否决：把分离/删除的区分放到了线的错误一侧，每次移除多一次往返，且每个其他客户端都要加同样的守卫。

**关闭或拉长空闲间隔。** 否决：只治症状，放弃了分离本要换取的内存收益。

**发送独立的 `host/session-detached` 帧。** 暂缓：当前没有客户端行为需要它（行的陈旧摘要可接受；刷新会重新基线化），新增 wire 事件需要 schema 与客户端处理，却换不来已观察到的收益。

## 后果

闲置超过分离间隔的会话保留侧边栏行；点击该行即按清扫设计从存储透明恢复。保留行的摘要（标题、相对时间）停留在最后已知值，直到下次 `session.list` 重新基线化。真实释放——今天只有 teardown 路径，因为 ApiProxy 自身仅通过清扫发起释放——仍会发送移除帧。
