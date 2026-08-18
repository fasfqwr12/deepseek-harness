# Agent Note: Unified desktop configuration and Ultra reasoning

Status: implemented

## Problem

桌面 profile 存在重复配置镜像，pi-ai 适配器也无法描述网关专用的 Ultra 思考等级。

## Decision

桌面 Web profile 读取唯一 UTF-8 YAML 配置和唯一凭据文件，历史会话继续使用现有 DSH home。Harness 的 pi-ai 适配器接受 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`，将 Ultra 放入适配器自有思考映射并按声明的 wire 拼写发送，不修改第三方 pi-ai 包。VS Code 风格布局继续消费既有会话、通知、记忆、模型和重试服务。

## Alternatives considered

**保留 JSON 与 YAML 镜像：** 否决，因为两个可写配置会漂移，受保护的旧副本也可能无法被运行时读取。

**修改 pi-ai 依赖：** 否决，因为适配器可以保持上游运行时契约并隔离本地扩展。

## Consequences

能力元数据只用于 Automatic 默认提示。手动 Off/Minimal/Low/Medium/High/XHigh/Max/Ultra 始终可选并发送给上游，最终以上游返回或错误为准。重试通过统一的模型菜单 override 配置（关闭或 0–20 次，初始间隔 100–60000 毫秒），并在状态条显示。本地 Node 24 Mock/CDP 已验收 127 项定向测试、九项可见菜单、历史会话/配置/凭据保留及实际运行 bundle。

桌面启动器可以直接运行 TypeScript Web 入口，日常开发无需生产 bundle。退役的设置和凭据副本保留在带时间戳的备份目录中以便回滚，活动运行时只有一个事实源。
