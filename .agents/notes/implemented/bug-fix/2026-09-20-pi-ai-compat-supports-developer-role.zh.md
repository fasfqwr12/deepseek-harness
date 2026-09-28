# Agent Note: pi-ai compat 暴露 supportsDeveloperRole 以兼容严格网关

Status: implemented

## Problem

pi-ai 的 `openai-completions` 传输层靠识别端点 URL 来决定系统提示的线上角色：凡是不认识的 URL，`supportsDeveloperRole` 一律猜为 true，于是声明了推理能力的模型，其系统提示会以 OpenAI 的 `developer` 角色发出。严格网关——比如 new-api 背后只认经典角色的后端（GLM 就是）——会拒绝该角色，中转站再把上游拒绝原样透传成 `422 {"message":"openai_error","type":"bad_response_status_code",…}`。这个故障伪装成思考等级问题：声明 `reasoningEfforts` 会翻转角色，导致路由在"不配档位"时正常、配上档位就失败，且与选了哪一档无关。配置已有的两个推理开关（[pi-ai per-model reasoning declarations](../feature/2026-08-08-pi-ai-per-model-reasoning-declarations.md)）表达不了"让系统提示保持 `system` 角色"，配置层面无解，唯一的绕法是本地改写角色的代理。

## Decision

`PiAiCompatProfile` 新增 `supportsDeveloperRole?: boolean`，与两个推理开关走同一条 模型 → 路由 → 已安装 catalog 条目 → pi-ai URL 猜测 的解析链，并穿线进模型的 `OpenAICompletionsCompat`——pi-ai 的角色判定（`model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"`）正是从那里读取。声明 `false` 即可让推理模型的系统提示保持 `system` 角色。该开关与其余两个一样只存在于 `openai-completions`：在其他协议的模型上设模型级开关会使解析失败，路由级默认值跳过其他协议的模型，完全没有 completions 模型的路由被拒绝。

## Alternatives considered

- **给 pi-ai 的 URL 识别扩充已知中转站主机名。** 落败：主机名集合是开放的——new-api 部署之间没有公共主机名，猜测对下一个网关照样是错的，按部署配置才是可持续的更正方式。
- **在本地代理里改写角色**（本部署已为一个 Gemini `store` 怪癖跑着一个）。落败：每个坏网关多一个常驻进程，鉴权与流都要过用户自己维护的代码；声明式开关让传输层自己说对方听得懂的话。
- **把路由改走 `anthropic-messages` 协议**，它把系统提示放在顶层字段，根本不发该角色。作为通用修复落败：整个线上方言都被换掉，放弃 `openai-completions` 的分发行为；它仍是"网关同时说 Anthropic"时的可用出路，本部署的 GLM 路由在 harness 重建前正是这么跑的。

## Consequences

换来的：严格 openai-completions 网关上的推理模型无需代理、无需换协议即可工作，且修复是声明式配置而非某个部署独有的代码。付出的：compat 配置面在推理分发开关之外混入了一个传输角色开关，名称与 README 的措辞仍叫"reasoning-dispatch"，覆盖面略宽于其名。仍未解决：对不认识的 URL，pi-ai 的猜测依然乐观——若网关是静默丢弃 `developer` 消息而非报错，仍需显式 `false`，这里没有任何检测能抓住静默丢弃。

## Testing

`catalog.spec` 钉住解析行为：路由级 `false` 落到声明推理的模型上、模型级胜过路由级、非 completions 协议上的模型级开关使解析失败。另用抓包代理对着故障网关做了端到端验证：带开关时请求角色为 `["system","user"]` 与 `["system","user","assistant","tool"]`，带工具调用与推理块的会话完整跑通；同一路由不带开关时每次尝试都 422。
