# ZCode（个人定制分支）

> **本仓库是基于官方 ZCode 开源项目二次开发的定制分支（fork），不是官方发行版。**
>
> 本项目与智谱 Z.ai / ZCode 官方团队**没有隶属、合作、授权或背书关系**，仓库中出现的 "ZCode" 名称与图标仅用于说明继承自上游的代码来源。使用前请务必阅读文末的[二次开发声明](#二次开发声明)与[免责声明](#免责声明)。

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>

本定制分支在官方 ZCode 的基础上做面向个人使用的二次开发，扩展了模型审查、会话执行环境与若干交互能力。（本仓库原名 `Myzcode`，2026-10-13 迁移到 [qianmeng406/ZCode](https://github.com/qianmeng406/ZCode) 后该名称已废弃；旧仓库仅保留历史，不再作为合并对象或发布目标。）

| 项目         | 说明                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| 上游项目     | [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）                              |
| 本仓库       | [qianmeng406/ZCode](https://github.com/qianmeng406/ZCode)                                    |
| 定制主线分支 | `main`（默认分支，包含全部定制内容与修复）                                                    |
| 桌面端       | 基于官方 ZCode 桌面版二次构建（Preview 构建身份，产物名 `ZCode Preview`）                    |
| 许可证       | Apache-2.0（继承上游，见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)）                        |

## 上游版本与同步状态

- **官方最新源码**：截至 2026-10-11，官方 `main` 为 [v3.15.1 对应提交 `aac47556`](https://github.com/zai-org/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f)，于 2026-10-10 更新。该次更新包含 UI Plugin、内联 Gen UI，以及桌面端、远程工作区与 Agent 能力和回归测试的扩展。
- **本定制版的上游基线**：本仓库基于官方 [v3.15.1 对应提交 `aac47556`](https://github.com/zai-org/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f)，根目录 `package.json` 版本为 `3.15.1`。定制功能以提交序列套用在官方基线之上（迁移提交与后续功能提交）；后续跟进官方新版本的流程见 [docs/upstream-sync.md](docs/upstream-sync.md)。
- **查看官方文档**：[中文 README](https://github.com/zai-org/ZCode/blob/main/README.md)、[英文 README](https://github.com/zai-org/ZCode/blob/main/README.en.md)、[UI Plugin 开发说明](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.md)。官方新版中的功能、目录和命令不一定存在于本定制版，请以当前检出的源码与 `package.json` 为准。

- 2026-10-18：新增**会话执行环境（本机 Linux / WSL）**——可在单个聊天会话上启用本机 WSL 的 Linux 执行环境，该会话的命令在 Linux 中运行，而聊天、模型配置、历史与其他会话不变（见下文「新增功能」）；同时统一仓库换行策略（`.gitattributes` 加 `* text=auto`，消除上万条行尾假改动），并补齐官方 v3.15.1 基线的同步记录与随访步骤（[docs/upstream-sync.md](docs/upstream-sync.md)）。注意：**官方 `main` 自 2026-10-11 起的变动尚未复核**——本次整理时本机无法连接 github.com，基线仍按上次成功核对记录。
- 2026-10-16：新增三项会话体验功能：**上游模型拉取**（添加模型弹窗从供应商 `/models` 端点拉取模型 ID 下拉选择）、**上下文卡片压缩按钮**（一键触发 `/compact`）、**Composer 主轮指标胶囊**（输入框下方常驻显示首 token 耗时、生成速度与输出 token，仅统计主轮请求）；重新产出 `ZCode Preview` 安装包。
- 2026-10-15：新增 **Beta 模式**（提示词融合模式测试版本），随后调整为独立工作模式（移除极简模式入口，Beta 权限为完全访问）并重新产出 `ZCode Preview` 安装包（`dist-new/`，含独立模式调整；运行中的旧实例不受影响）。
- 2026-10-13：把旧 Myzcode 定制功能迁移到本仓库，基线官方 v3.15.1。
- 2026-10-10：更新至 ZCode v3.15.1 版本。
- 2026-9-23：更新至 ZCode v3.14.3 版本。

## 本定制版的新增与改动

以下列出本仓库在官方 v3.15.1 基线之上的定制能力与修改，不表示这些能力全部为本项目独有。官方后续版本可能提供相似功能。

### 一、新增功能

- **双模型审查（Oracle）**：回合结束后自动复审本轮 diff，也支持手动重审；含深度审查（派发只读子代理多轮取证）、审查进度展示、一键修复与审查结果持久化。
- **计划批准时选择执行模型与推理等级**：退出计划模式时可直接指定后续执行所用的模型与推理档位。
- **会话回合导航**：按回合在长会话中快速跳转，配套设置开关与全量历史加载协调。
- **权限/协作模式扩展**：新增 **资料查询（research）只读模式**（内置多个免密钥检索渠道）。（曾有 `zcodeUpdate` 更新模式与 `minimal` 极简模式，入口均已移除：`zcodeUpdate` 改走常规上游合并更新（见 [docs/upstream-sync.md](docs/upstream-sync.md)）；`minimal` 仅保留历史会话读取兼容，不再作为可选模式。）
- **Beta 模式（提示词融合模式测试版本）**：输入区模式菜单中的独立单选模式（`mode=beta`），与变更前确认、自主模式、资料查询及完全访问互斥；结合授权内推进、最小完整修改、合理子代理委派和证据验证等行为原则，保留技能、记忆与项目规则。**默认「完全访问」权限（减少确认次数）**；计划开关独立（开启时只读），选择其他工作模式即退出 Beta。设计与验收边界见 [Beta 模式说明](apps/zcode-cli/docs/design/v2/loop/fusion-context-profile.md)。
- **上游模型拉取**：添加模型弹窗支持从当前供应商配置的 OpenAI-compatible `/models` 端点拉取模型 ID，提供可搜索下拉选择（选择仅填充草稿，保存仍需确认）；内置官方账号类供应商显式不支持，失败时保留手动输入。协议面不传输凭据，错误按分类脱敏。
- **上下文卡片压缩按钮**：上下文用量面板内新增「压缩上下文」按钮，一键触发既有 `/compact` 压缩链路；压缩进行中或会话不可提交时自动禁用，不引入第二条压缩协议。
- **Composer 主轮指标胶囊**：输入框下方常驻显示最近一轮主请求（main_turn）的首 token 耗时、生成速度（tok/s）与输出 token 数；子代理、压缩、标题生成等非主请求不影响指标，缺失事实显示 `--` 占位而不估算。规格见 [docs/features/](docs/features/)。
- **提示词优化器**：输入区新增提示词优化入口，可指定优化所用模型。
- **远端资源随包分发 + SSH 常驻工作区**：远端工作区（SSH/WSL）所需的 server bundle、node 运行时、agent 运行时与搜索工具**随安装包分发**（安装目录 `resources/remote-assets`），部署时由桌面端直接读取本地文件再 SFTP 上传，**全程不访问任何 CDN**；「远端服务器下载」模式缺省走 ZCode 官方 CDN（拉官方产物，不含本定制版远端改动），自建 CDN 发布树保留为可选覆盖。同时支持 SSH 远程工作区**断开不终止任务、重连接回同一运行时**。
- **会话执行环境（本机 Linux / WSL）**：在会话工具栏为**单个聊天会话**启用本机 WSL 的 Linux 执行环境；该会话的 Bash/文件命令经宿主反向请求交给 WSL 中的执行服务运行，项目文件仍以路径映射访问**同一份原文件**（不复制、不同步、不迁移会话历史与模型凭据）。准备过程可取消、失败不提交且不改变原会话；已启用 Linux 的会话在恢复时若环境不可用会**明确阻止执行**，不偷偷回落到本机。首版边界：不承诺任务级加速（逐命令对照与口径见验收报告），不是容器级安全沙箱。规格见 [会话执行环境规格](docs/research/session-linux-execution.spec.md)。

### 二、与官方版的差异边界（明确不做的事）

- **不复制官方压缩代码**，不声称与官方通信协议兼容、不声称获得官方认证。

## 分支说明

- `main`：**默认分支与定制主线**，包含全部定制内容、修复与文档，后续开发都在这里进行。

## 上游 ZCode 使用说明

以下说明以本定制仓库当前可用的初始化、开发与构建入口为准，沿用上游的基础流程，并包含本仓库对资源准备、远端资源随包分发等环节的调整。它不是官方最新 README 的完整镜像；本定制版的能力按上文各章节的说明使用。

### 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

### 开发与运行

#### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

#### 远程功能（SSH/WSL）

**打包版默认不依赖 CDN。** 构建时 `prepare:runtime-assets` 会把 mock-cdn 里目标平台（默认 `linux-x64`，可用 `ZCODE_REMOTE_CDN_PLATFORMS` 改）的远端运行时资源裁剪出来，经 electron-builder 打进安装目录的 `resources/remote-assets`；连接远程项目时资源方式选默认的「本地上传（随包资源）」，桌面端直接读取随包文件并 SFTP 上传，不发起任何 CDN 请求。

- 资源树体积：单平台约 165 MB（`node` 运行时占约 117 MB），会随安装包分发；用 `ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1` 可跳过随包（此时本地上传无资源可用，需走「远端服务器下载」）。
- 想改用外部资源目录而不重打包：设置 `ZCODE_REMOTE_ASSET_LOCAL_DIR=<含 releases/<版本>/ 的目录>` 即可覆盖随包资源；目录缺件时会明确报错，不会静默回退官方 CDN。
- 手动重建资源树：`pnpm prepare:local-remote-assets --platforms linux-x64`（产出在 `packages/desktop/dist-remote-assets-local`）。
- 仍需自建 CDN 发布树的场景只剩：安装包内没有随包资源（`ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1` 打包），或想让「远端服务器下载」模式也用 fork 产物——该模式缺省拉 **ZCode 官方 CDN** 的产物（不含常驻运行等本定制版远端改动，连接时会明确拒绝「常驻运行 + 远端服务器下载」组合）。

开发态：先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，同样不访问 CDN。

构建后想复核「随包资源 → 真实远端 → 零 CDN」整条链路，可跑验收脚本（支持 WSL 与任意 SSH 目标）：

```bash
npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl
npx tsx packages/server/scripts/remote-local-assets-check.ts --ssh <host> --user <name> --password-file <file>
```

#### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

#### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

#### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

### UI Plugin 开发

参见 [UI Plugin：能力、API 与调试](UI_PLUGIN.md)，从 Excalidraw 的画布协作示例开始，了解插件安装更新、页面 API 和宿主联调入口。

**向 `zcode-plugins` 提交插件 PR 时，必须在 PR 模板中声明是否为 UI Plugin，并填写插件名称。** 判断标准见[提交 PR 时声明插件类型](UI_PLUGIN.md#提交-pr-时声明插件类型)。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

> 注意：请勿把任何令牌、密钥或个人凭据提交到仓库；需要凭据的环节请只放在本地未跟踪文件中。

### 打包

**发布打包（正式/Preview 双身份安装包、APK、随包远端资源、发布前核对清单与已知坑位）见
[BUILD.md](BUILD.md)**，里面列了完整命令序列和踩过的坑，出包前照着核对一遍即可。

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

#### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

#### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

以下为本定制仓库的主要目录；`本定制版新增` 表示相对上游 v3.15.1 基线新增，不是官方最新源码树的完整目录清单。

| 目录                                                 | 职责                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包                         |
| `packages/web`                                       | Web 客户端                                                       |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接                                  |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                                       |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态                           |
| `packages/services`                                  | 业务服务与持久化                                                 |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK                       |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现                                    |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具                                     |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料                           |

## 二次开发声明

1. **来源**：本项目是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 开源代码的**二次开发（fork）**，遵循上游 Apache-2.0 许可证。上游原始代码、文档与资源的著作权归其原作者与 zai-org/ZCode 项目所有。
2. **非官方**：本项目由个人维护，**不是**官方产品，与 Z.ai、智谱、ZCode 官方团队**无任何隶属、赞助、合作或背书关系**。本项目产出的安装包、APK、bundle 均非官方发行物。
3. **改动范围**：本仓库在上游基础上新增了自定义模型渠道、双模型审查等功能，并修改了部分既有模块。改动清单见上文「本定制版的新增与改动」。
4. **协议与兼容**：本项目**不复制**官方压缩/混淆代码，**不接入**官方私有中继（relay）或账号后端，也**不声称**与官方协议兼容或通过官方认证。请勿将本项目描述为官方发行版或官方合作产品。
5. **名称与标识**：仓库中出现的 "ZCode" 名称、图标等仅用于说明代码来源与用途，不代表官方授权。

## 免责声明

1. **无担保**：本项目按「现状」（AS IS）提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保。作者不对因使用或无法使用本项目而产生的任何直接或间接损失（含数据丢失、服务中断、设备损坏、收益损失）承担责任。
2. **自担风险**：本定制版包含可对电脑上运行的 ZCode 发起有副作用操作的能力（创建任务、发送输入、停止执行、处理审批等）。使用前你应自行评估风险，务必只在**你自己的设备**与**你拥有合法授权**的环境上使用，并妥善保管相关凭据。因误用、配置不当或凭据泄露造成的后果由使用者自行承担。
3. **不上传、不采集**：本项目不提供任何官方后端服务，作者不会收集你的数据。
4. **合法使用**：使用者须自行确保其使用行为符合所在地区的法律法规、上游项目条款及第三方服务（模型供应商、云服务商等）的使用协议。**严禁**将本项目用于未经授权的入侵、监控、数据窃取或其他违法用途。
5. **模型与费用**：本项目可能调用第三方模型服务，相关账号、额度、费用与内容合规由使用者自行负责；本仓库不预置任何官方密钥或额度。
6. **与上游的关系**：本项目可能滞后于上游、包含上游尚未合并或已被移除的改动，也可能存在缺陷。请勿因本项目的问题向上游项目或官方团队追责。
7. **无维护承诺**：作者不承诺持续维护、及时修复或长期兼容任何上游版本。

> 若你不同意上述任一条款，请立即停止使用并删除本项目全部副本。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)（继承自上游）。
