# Agent Note: 在打包安装中保留平台可选依赖

Status: implemented

[English](2026-08-23-packed-install-platform-optionals.md) | 中文

## Problem

打包工件验证曾使用 npm 的全局 `--omit=optional` 选项安装一次性 consumer。这会把所有可选依赖都视为可舍弃功能，但多个运行时依赖采用可选包这一标准机制选择平台载荷。Koffi 会选择 `@koromix/koffi-win32-x64` 等预编译原生载荷；打包版 ripgrep 也采用同一模式。省略这些包会让 Windows consumer 尝试不受支持的源码构建，或在加载缺失的平台可执行文件时失败。

Landlock entry 同样把平台包声明为可选依赖，但每个平台包都声明了支持的 `os` 与 `cpu`。npm 已经会在 Windows 上跳过不兼容的 Linux 包，并在受支持的 Linux runner 上只选择匹配的包。因此，全局省略并未改善 Landlock 可移植性，只移除了 Windows 必需的载荷。

## Decision

`verify-packed-install` 运行不带 `--omit=optional` 的 `npm install`。npm 解析真实依赖图，并应用每个可选包的 `os` 与 `cpu` 约束。验证不会把 Koffi、ripgrep 或某个 Landlock 平台包合成为顶层依赖，也不会安装原生编译工具链来补偿缺失的预编译载荷。

安装参数与可执行文件选择位于可导入的 helper 中，由聚焦单元测试固定完整命令策略。Windows 使用当前 Node 可执行文件运行 npm JavaScript CLI，因为经过安全加固的 Node 进程启动不会在无 shell 时执行 `npm.cmd`；其他平台直接调用 `npm`。外部 consumer 验证仍是行为证明：它在 workspace 外安装打包集合，并以普通 Node 驱动已安装的 `dsh --version` 入口。各平台发布 lane 继续负责在对应主机上验证原生运行时加载。

## Alternatives considered

**在 Windows 验证机安装 CMake 与原生编译器。** 拒绝，因为受支持的 Koffi 路径是其预编译平台包。源码构建会掩盖不完整的 consumer 依赖图，还会增加外部用户不应具备的工具链。

**在一次性 consumer 中直接声明 `@koromix/koffi-win32-x64`。** 拒绝，因为这会在 Koffi manifest 外硬编码一种操作系统与架构，绕过待验证的依赖关系，并要求为每个平台再增加分支。

**只省略 Landlock 的可选包。** 拒绝，因为 npm 的 omit 选项作用于整个依赖类别，而不是某一个包子树；Landlock 平台 manifest 已经表达了精确兼容性过滤。

## Consequences

打包安装会通过 npm 的平台检查包含兼容的可选运行时载荷，并跳过不兼容载荷。在 Windows 上，Koffi 预编译包无需 CMake 即可加载；Linux 专用 Landlock 包保持缺席。在匹配的 Linux runner 上，npm 可能安装对应的 Landlock 二进制包，这就是 manifest 声明的 consumer 行为。

Windows 验证要求 npm 按受支持的 Node 安装器与 CI setup 布局，随当前 Node 安装在 `node_modules/npm/bin/npm-cli.js`。仅含 Node、没有 npm 的便携运行时会明确失败，而不会退回 shell 或另一个全局 shim。

除入口包外，验证还可能获取外部依赖拥有的兼容可选包。这是有意的 registry 流量，与真实 consumer 安装一致。若某个包的平台元数据声明错误，它会在本验证中失败，而不再被全局省略掩盖。
