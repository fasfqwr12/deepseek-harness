# 重试分类器把配额型网关失败判为终态

## Summary

- **Status**: Proposed
- **Date**: 2026-09-24
- **Scope**: `packages/llm/llm`, `packages/llm/llm-pi-ai`

一个对接「订阅转 API」中转的长会话（11 条 provider 路由共 650 次 `llm/retry`）显示，重试引擎把注定失败的重试全部烧完：裸 `402 status code (no body)` 重试了 11 次，某网关的中文配额墙（`您的使用量已超出频率限制，将在 2026-09-24 15:25:52 UTC+8 重置`）连续重试 20 次——尽管消息本身写明了数小时后的重置时间。全错误重试模式对真正瞬时的故障是正确的；缺的是对结果恒定的失败的终态分类。

重试分类器（`llm-pi-ai/src/stream.ts` 的 `classifyPiAiError`）此前把这两类都映射进了可重试码——`402` 落入 `PI_AI_ERROR` 兜底，429 重置时间戳文案命中 `RATE_LIMIT` 分支。重试策略重试一切码，因此两者都产生纯等待时间：数分钟的退避后依然是同样的失败。

## Decision

新增三条分类规则，与 OpenAI、Anthropic、Google 三个 SDK 的朴素状态码语义对齐（`shouldRetry`：重试 408/429/5xx；把 402 系配额耗尽视为终态）：

1. **裸 `402` → `QUOTA`**（`llm-pi-ai/src/stream.ts`）。应答 `402 status code (no body)` 的中转网关意味着 key 背后的余额已用尽；每次尝试的失败结果完全相同。归类为终态配额码，重试引擎不再重试。
2. **裸 `408` → `TIMEOUT`**（`llm-pi-ai/src/stream.ts`）。该裸状态与客户端超时同属瞬时超时类；三个 SDK 参考实现都重试它。排在 `INVALID_REQUEST` 之后，保证 `400` 文案优先。
3. **远期重置时间 → `QUOTA`**（`llm/src/error.ts`，新增 `isFarFutureRateLimitReset()`）。宣告的重置点超过 `RATE_LIMIT_QUOTA_HORIZON_MS`（60 秒）的 429 消息，无法在单请求的重试循环内等到重置。该函数解析绝对时间戳（`YYYY-MM-DD HH:MM[:SS]`，支持 `UTC+8`/`GMT+08:00`/裸 `+08:00` 时区后缀）与相对时限（英文 `in|after <n> <unit>`、中文 `<n>小时|分钟|秒后`），无可解析时限时返回 false，因此无时限的限流保持瞬时 `RATE_LIMIT` 类。阈值内的时限同样保持瞬时。

60 秒地平线是策略下限而非实测最优：重试循环的总退避预算（8-20 次 × ≤10 秒）连 2 分钟的窗口都等不完，因此超过大约一个退避周期的任何时限效果相同。保留常量是为了让边界显式、可测。

## 生产日志证据

修改后对 650 条已记录失败的分类：所有 TRANSPORT/SERVER/TIMEOUT/RATE_LIMIT 行保持可重试类；11 行裸 402 与 20 行配额墙移入 `QUOTA`。没有既有正确分类发生回归。一条文案值得注意：`400 status code (no body)` 在 harness 分类器运行前被 pi-ai 的 Cerebras 启发式（`utils/overflow.js` 的 `/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i`）认领为上下文溢出，因此保持 `CONTEXT_WINDOW_EXCEEDED`——回归表钉住这一上游行为，使未来 pi-ai 升级能暴露差异。

## Verification

- `packages/llm/llm/tests/error-classify.spec.ts`（新增）：`isFarFutureRateLimitReset` 的 7 个单元用例——UTC 偏移应用、地平线阈值边界、英/中相对时限、无文案、不可解析时间戳。
- `packages/llm/llm-pi-ai/tests/convert.spec.ts`：32 行表驱动回归，覆盖逐字的生产失败文案（与时钟无关），外加时钟冻结的显式用例——远期重置（`2099-01-01 08:00:00 UTC+8` → `QUOTA`）、过去时限消息（→ `RATE_LIMIT`）、裸 `402`（→ `QUOTA`）、裸 `408`（→ `TIMEOUT`）。
- `packages/llm` + `packages/llm-pi-ai` 全套件：719 通过。
- `tsc -b tsconfig.host.json`：干净。

## Risks

- 若某网关把 `402` 用于瞬时过载（无已知实例），将停止重试而错过恢复；本修复用这一个假想恢复换取 31 个实测浪费的重试周期。
- 相对时限解析器只接受显式单位；`resets soon` 之类的文案保持 `RATE_LIMIT` 继续重试，这是安全默认。
- 时区后缀解析处理 `重置`/`reset`/串尾之前的 `UTC±h`、`GMT±h[:mm]` 与裸 `±hh:mm`；带不可解析时区的时间戳回退为 UTC，只会缩短计算出的时限（瞬时、继续重试）——绝不会反向。

## References

- [OpenAI node SDK `shouldRetry`](https://github.com/openai/openai-node/blob/master/src/client.ts) — 状态码重试集合与 `Retry-After` 封顶。
- [Anthropic TS SDK `shouldRetry`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts) — 相同状态码集合；`APIConnectionError` 文案 `"Connection error."` 与生产日志逐字一致。
- [Google Genai SDK 重试配置](https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py) — 状态码白名单 408/429/500/502/503/504。

## Consequences

中转网关的配额墙与余额耗尽现在立即结束该 step，而不是耗尽全部退避预算；真正瞬时的传输、服务器、超时与限流失败保持与之前完全一致的重试行为。未来网关的新文案加入回归表，分类器的修改以记录的现实而非虚构 fixture 验证。
