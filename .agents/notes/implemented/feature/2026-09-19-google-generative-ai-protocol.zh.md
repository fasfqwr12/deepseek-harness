# Agent Note: google-generative-ai 作为可配置线协议

Status: implemented

[English](2026-09-19-google-generative-ai-protocol.md) | 中文

## 问题

部署在 Gemini 后端、但只能经 OpenAI 兼容转换层（sub2api 类商业网关）访问的
DSH 路由，每个带工具的请求都失败于 `400 function_response.name: Name
cannot be empty`。两处缺陷都在转换层而非 DSH：`type: 'array'` 缺 `items`
的工具模式被 Gemini 严格 proto 校验拒绝；携带 `tool_calls` 的 assistant
消息省略 `content` 字段时，回放的工具结果丢失函数名（A/B 验证：同一请求
`content: null` 成功、省略字段失败）。DSH 的序列化本身符合 OpenAI 规范；
该路径上路由无法绕开转换层——而同一网关的原生 Gemini 端点经实测，非流式、
SSE 流式、key 鉴权均正常。

## 决策

在可配置协议表中提供 `google-generative-ai`，让路由直接声明 Gemini 原生
协议，而非穿过有损转换层。pi-ai 已自带实现
（`@earendil-works/pi-ai/api/google-generative-ai.lazy`，与
`googleProvider()` 使用同一工厂）；唯一的闸门是
`packages/llm/llm-pi-ai/src/provider.ts` 的协议表，其契约（每协议一行，
部署凭 key、端点、headers 即可完整描述）容纳它：Google 客户端原样消费含
版本路径的 `baseURL`，鉴权走 harness 的 api-key seam，与既有三项一致。

- `PROTOCOLS` 增加 `'google-generative-ai': googleGenerativeAIApi`；设置
  schema（`z.union(supportedProtocols())`）与读取它的每个配置面——包括
  Web GUI 的协议下拉——自动跟随，UI 零改动。
- `baseURL` 携带版本路径（`https://gateway.example/v1beta`）；pi-ai 置
  `httpOptions.apiVersion = ""`，不再追加。省略时沿用 catalog Google
  provider 自带的 `…/v1beta` 端点。
- 发现（`GET /models` 询问）仍对该协议报 `DISCOVERY_UNSUPPORTED`，模型面
  回退手工录入——对列表形状非原生的网关是正确行为。
- `compat` 推理开关仍仅限 `openai-completions`；该协议的路由带路由级
  compat 开关仍被拒绝，与 `anthropic-messages` 一致。

## 后果

- Gemini 原生路由不再依赖第三方的转换正确性：工具模式、工具结果函数名、
  流式语义都是协议自身的，不是转换出来的。
- 变体 id 模式照常工作：网关拼写的模型 id（`gemini-3-flash`、
  `gemini-3.1-pro-high`…）按路由列出，容量按 profile 默认，因为路由的
  模型经 `resolveRouteModels` 继承表内协议。
- 既有路由不受影响：新增的是选项；不重写已存储 profile，表外协议的拒绝
  诊断仍列出支持集。

## 验证

- `packages/llm/llm-pi-ai/tests/catalog.spec.ts`：新用例断言
  `supportedProtocols()` 含该协议、声明路由原样落地端点；既有拒绝集
  （`bedrock-converse-stream`、`google-vertex`、`azure-openai-responses`、
  `openai-codex-responses`）仍排除它并继续拒绝。
- 变更后包内全套测试通过（55 项）。
- 变更前对线上端点实测：原生 `POST /v1beta/models/{m}:generateContent`、
  `?alt=sse` 流式、`x-goog-api-key` 鉴权全部可用；OpenAI 兼容路径复现
  上述两处转换缺陷，故有原生路由。
