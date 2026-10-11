# Myzcode

> **本仓库是基于官方 ZCode 开源项目二次开发的定制分支（fork），不是官方发行版。**
>
> 本项目与智谱 Z.ai / ZCode 官方团队**没有隶属、合作、授权或背书关系**，仓库中出现的 "ZCode" 名称与图标仅用于说明继承自上游的代码来源。使用前请务必阅读文末的[二次开发声明](#二次开发声明)与[免责声明](#免责声明)。

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>

Myzcode 在官方 ZCode 的基础上做面向个人使用的二次开发，主要方向是**「让手机也能远程操控电脑上运行的 ZCode」**，并额外扩展了模型渠道、模型审查与若干交互能力。

| 项目         | 说明                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| 上游项目     | [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）                              |
| 本仓库       | [qianmeng406/Myzcode](https://github.com/qianmeng406/Myzcode)                                |
| 定制主线分支 | `main`（默认分支，包含全部定制内容与修复；`custom/command-code-channel` 为已并入的历史分支） |
| 桌面端       | 基于官方 ZCode 桌面版二次构建（Preview 构建身份，产物名 `ZCode Preview`）                    |
| 移动端       | 「Myzcode」Android App，包名 `com.zcode.myzcode`，版本 `0.1.0`                               |
| 许可证       | Apache-2.0（继承上游，见 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md)）                        |

## 上游版本与同步状态

- **官方最新源码**：截至 2026-10-11，官方 `main` 为 [v3.15.1 对应提交 `aac47556`](https://github.com/zai-org/ZCode/commit/aac4755666d09fdcd70272fcf063c077a639015f)，于 2026-10-10 更新。该次更新包含 UI Plugin、内联 Gen UI，以及桌面端、远程工作区与 Agent 能力和回归测试的扩展。
- **本定制版的上游基线**：[v3.14.3 对应提交 `29628c9a`](https://github.com/zai-org/ZCode/commit/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，根目录 `package.json` 当前版本仍为 `3.14.3`。本仓库尚未合并上游 v3.15.1；更新本说明不代表完成源码升级。
- **查看官方文档**：[中文 README](https://github.com/zai-org/ZCode/blob/main/README.md)、[英文 README](https://github.com/zai-org/ZCode/blob/main/README.en.md)、[UI Plugin 开发说明](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/UI_PLUGIN.md)。官方新版中的功能、目录和命令不一定存在于本定制版，请以当前检出的源码与 `package.json` 为准。

## 本定制版的新增与改动

以下列出本仓库在上游 v3.14.3 基线之上的定制能力与修改，不表示这些能力全部为本项目独有，也不表示已逐项核对最新 `origin/main`。官方后续版本可能提供相似功能；本定制版的 Companion 仍是独立的自托管实现，不代表与官方远控协议兼容。

### 一、手机远控（Companion）——本定制版的主要改动

让手机以**同一套 WebUI**（窄视口适配）附着到电脑上**已经打开并显式共享**的工作区，实时镜像任务、会话与执行结果；不在手机侧新开第二个执行者。

> **需要自备服务器**：本仓库**不提供、也不内置任何接入服务地址**（既不指向官方私有中继，也不指向作者自己的机器）。手机远控必须由你**自行部署**一台接入服务（gateway）。完整步骤与**可直接交给 AI 的接入提示词**见下文「[手机远控：自建服务器与接入配置](#手机远控自建服务器与接入配置)」。没有服务器时，远控不可用，但其余功能不受影响。

- **自托管接入与转发服务**：新增 `packages/companion`，含设备配对、节点登记、授权（grants）、attachment 注册与一次性 capability、控制面/数据面分离的 gateway（Hono + ws），数据面为字节透传，gateway 不解释、不缓存、不重排。
- **节点连接器**：新增 `packages/server/src/companion`，桌面端由 Electron Main 出站连接并附着本机已打开工作区；云端由 resident 守护进程出站连接。手机附着到**既有**运行时，不隐式启动新运行时。
- **频道收窄裁决**：`narrowingFacade` + `channelPolicy` 对手机暴露收窄后的 `IZCodeAgentService` 频道（T0 全拒 / T1 只读 / T2 受限），跨工作区只读任务列表与事件订阅按「已共享工作区集合」逐项放行，其余一律强制绑定或拒绝，fail-closed。
- **手机端只读任务索引**：跨共享工作区的任务摘要聚合；sessions-index 不可用时回退磁盘 tasks-index，gateway 只做临时聚合，不持有任务权威。
- **配对与设备授权**：6 位数字配对码 + 二维码/链接、一次性 capability、设备授权查看/收缩/撤销，凭证以哈希存储。
- **连接恢复**：心跳 + watchdog、指数退避重连、`ConnectionSession` 代次恢复、命令 ACK 丢失先对账（不盲目重发创建/输入/审批）。
- **移动端 App**：新增 `packages/mobile`（Capacitor Android），应用名 Myzcode，复用同一套 Web UI 资源，而非另写一套手机界面。
- **自托管部署文档**：接入服务需你自行部署；步骤、私密值放置与「交给 AI 执行的接入提示词」见上文「[手机远控：自建服务器与接入配置](#手机远控自建服务器与接入配置)」，深入细节见 [packages/companion/specs/DEPLOY.md](packages/companion/specs/DEPLOY.md) 与 [packages/companion/specs/companion-gateway.md](packages/companion/specs/companion-gateway.md)。

### 二、其余新增功能

- **双模型审查（Oracle）**：回合结束后自动复审本轮 diff，也支持手动重审；含深度审查（派发只读子代理多轮取证）、审查进度展示、一键修复与审查结果持久化。
- **计划批准时选择执行模型与推理等级**：退出计划模式时可直接指定后续执行所用的模型与推理档位。
- **会话回合导航**：按回合在长会话中快速跳转，配套设置开关与全量历史加载协调。
- **权限/协作模式扩展**：新增 **资料查询（research）只读模式**（内置多个免密钥检索渠道）、`minimal`、`zcodeUpdate` 等模式。
- **提示词优化器**：输入区新增提示词优化入口，可指定优化所用模型。
- **远端资源随包分发 + SSH 常驻工作区**：远端工作区（SSH/WSL）所需的 server bundle、node 运行时、agent 运行时与搜索工具**随安装包分发**（安装目录 `resources/remote-assets`），部署时由桌面端直接读取本地文件再 SFTP 上传，**全程不访问任何 CDN**；「远端服务器下载」模式缺省走 ZCode 官方 CDN（拉官方产物，不含本定制版远端改动），自建 CDN 发布树保留为可选覆盖。同时支持 SSH 远程工作区**断开不终止任务、重连接回同一运行时**。

### 三、与官方版的差异边界（明确不做的事）

- **不接入官方私有 relay**，不复用官方账号后端；远控链路完全自托管。
- **不复制官方压缩代码**，不声称与官方通信协议兼容、不声称获得官方认证。
- **执行权威唯一**：任务执行始终发生在原 Host/运行时，手机与 gateway 都不创建第二个执行者。
- 手机首版**不可**进行凭据管理、任意文件系统访问、终端、服务端配置等特权操作。

## 手机远控：自建服务器与接入配置

> **这是手机远控能用的前提。** 本仓库**不提供任何公共接入服务**，也**不内置任何服务器地址**。要用手机远控，你必须自己准备并部署一台接入服务（gateway）。
>
> 没有自己的服务器 ⇒ 手机远控不可用；桌面端、模型渠道、模型审查等其余功能完全不受影响。

### 前置条件

| 项     | 要求                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| 服务器 | Linux x86_64，Node ≥ 24（`packages/companion` 使用 `node:sqlite`），网络可达 |
| 入口   | 公网 IP 或域名 + TLS 证书（手机端走 WSS/HTTPS；明文 HTTP 仅限局域网联调）    |
| 桌面端 | 本定制版桌面 App（产物名 `ZCode Preview`）                                   |
| 手机端 | 自行构建的 Myzcode APK（`packages/mobile`）                                  |

### 配置方法（四步）

| 步骤                      | 在哪做              | 做什么                                                                                                                                                                          |
| ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 构建并部署接入服务** | 本仓库 → 你的服务器 | 在 `packages/server` 执行构建，得到 `zcode-companion.cjs` / `zcode-server.cjs`，按目录布局放到服务器（如 `/www/zcode-companion`），用 PM2 或面板把 serve 常驻                   |
| **2. 登记节点**           | 服务器命令行        | `ZCODE_COMPANION_CONTROL_DB=<部署目录>/data/control.db node zcode-companion.cjs register-node --id desktop-main --name <名称> --kind desktop`；输出**一次性**节点令牌，立即另存 |
| **3. 配置桌面端**         | 桌面 App            | 「设置 → Myzcode 桌面直连」：填 `wss://<你的服务器>` + 节点令牌，勾选要开放给手机的工作区，保存启用                                                                             |
| **4. 配对手机**           | 桌面弹窗 + 手机 App | 桌面弹窗点「生成配对码」得到 6 位码（一次性、15 分钟）；手机在配对页填**你的接入服务地址** + 该码完成配对                                                                       |

完整目录布局、`.env` 与 PM2 细节、故障排查表见
[packages/companion/specs/DEPLOY.md](packages/companion/specs/DEPLOY.md)；
协议、授权与配对模型见
[packages/companion/specs/companion-gateway.md](packages/companion/specs/companion-gateway.md)。

### 私密值放哪（不要提交）

| 值                       | 放哪                                                         | 说明                                             |
| ------------------------ | ------------------------------------------------------------ | ------------------------------------------------ |
| 手机端预填的接入地址     | `packages/mobile/.env.local` 的 `VITE_COMPANION_GATEWAY_URL` | 构建期注入；未配置则配对页留空、手动填写         |
| 自建远端资源地址（可选） | 仓库根 `.env.local` 的 `ZCODE_CDN_BASE_URL`                  | 不配置则回落到官方默认                           |
| 节点令牌                 | 桌面端设置里填写；服务器侧为 `data/node.token`（0600）       | 桌面端令牌存入 OS 安全存储；**永远不要**写进仓库 |

`.env.local` 已被 `.gitignore` 忽略。请勿把任何服务器地址、令牌或密码提交到公开仓库。

### 让 AI 帮你接入（可直接复制的提示词）

把下面整段交给能访问你这台机器与服务器的 AI 编程助手（ZCode / Claude Code / Cursor 等），它会按仓库文档执行：

```text
你正在协助我把本仓库（Myzcode——官方 ZCode 的二次开发分支）的手机远控接入服务搭起来。

先完整阅读这两个文件，再动手：
- packages/companion/specs/DEPLOY.md（部署、目录布局、运维、故障排查）
- packages/companion/specs/companion-gateway.md（协议、配对与授权模型）

我的环境（缺失的请先问我，不要猜）：
- 服务器：<公网 IP 或域名>，Linux x86_64，已装 Node ≥ 24
- 服务器 TLS：<宝塔/其它面板已配好证书 | 需要帮助申请>
- 部署目录：<如 /www/zcode-companion>
- 要共享给手机的工作区目录：<填写>
- 桌面端系统：<Windows | macOS>
- 手机端：<已有 Myzcode APK | 需要一起构建>

请按顺序执行；每一步先说清"将要做什么、影响面"，再执行：
1. 在本仓库构建服务端产物（zcode-companion.cjs、zcode-server.cjs 及 pty 预编译），说明各产物来源与放置路径。
2. 上传/放置到服务器部署目录，按 DEPLOY.md 的布局建好 data/ 与 logs/。
3. 登记桌面节点并保存令牌（register-node --kind desktop），把一次性令牌提示我立即另存。
4. 用 PM2 或面板把 serve 常驻，确认健康检查通过、日志路径可见。
5. 桌面 App 打开「设置 → Myzcode 桌面直连」，填入 wss://<我的服务器> + 节点令牌，勾选开放工作区，保存启用。
6. 手机端：构建 APK 前在 packages/mobile/.env.local 写 VITE_COMPANION_GATEWAY_URL=https://<我的服务器>（或用已有 APK 手动填地址），用桌面生成的 6 位配对码完成配对。
7. 验收：手机上能看到已共享工作区的任务与会话；创建一次任务，回到桌面确认是同一会话（执行者唯一）；断开网络再恢复，确认能自动重连。
8. 全程禁止把任何令牌、密码、服务器地址写入仓库或提交；凡是需要我手工输入凭据的步骤，列出来让我自己做。
```

### 常见问题

- **手机上看不到任何任务**：该工作区没有对手机开放。到桌面「Myzcode 桌面直连」把它加入开放列表。
- **配对码获取失败 / 连接被拒**：桌面端的 `wss://` 地址或节点令牌与服务器不一致；或服务器证书不匹配（检查证书是否过期）。
- **只想用其它功能**：完全跳过本节即可，远控模块不会影响桌面端正常使用。

## 分支说明

- `main`：**默认分支与定制主线**，包含全部定制内容、修复与文档，后续开发都在这里进行。
- `custom/command-code-channel`：早期开发用的定制分支，内容已全部并入 `main` 并与 `main` 保持同步，仅作历史保留。

## 上游 ZCode 使用说明

以下说明以本定制仓库当前可用的初始化、开发与构建入口为准，沿用上游的基础流程，并包含本仓库对资源准备、远端资源随包分发等环节的调整。它不是官方最新 README 的完整镜像；本定制版的能力（手机远控、自定义渠道等）按上文各章节的说明使用。

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

#### 移动端（Android，本定制版新增）

```bash
# 构建 Web UI → 同步到 Android 工程 → 产出 debug APK
pnpm --filter @zcode/mobile run apk:debug
```

需要 JDK 21 与 Android SDK；`JAVA_HOME` 指向 JDK 21（Android Studio 自带 JBR 即可）。产物位于 `packages/mobile/android/app/build/outputs/apk/debug/`。

配对页预填的网关地址取自构建期环境变量 `VITE_COMPANION_GATEWAY_URL`：仓库内**不内置任何具体地址**，自部署者在未跟踪的 `packages/mobile/.env.local` 中填写自己的网关；未配置时预填为空，需在配对页手动填写。

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

### 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

> 注意：请勿把任何令牌、密钥或个人凭据提交到仓库；本定制版的远控部署涉及自建服务器凭据，请只放在本地未跟踪文件中。

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

以下为本定制仓库的主要目录；`本定制版新增` 表示相对上游 v3.14.3 基线新增，不是官方最新源码树的完整目录清单。

| 目录                                                 | 职责                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/companion`                                 | **本定制版新增**：手机远控的 gateway、协议、配对与授权           |
| `packages/mobile`                                    | **本定制版新增**：Myzcode Android App（Capacitor）               |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包                         |
| `packages/web`                                       | Web 客户端                                                       |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接（含 `src/companion` 节点连接器） |
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
3. **改动范围**：本仓库在上游基础上新增了手机远控（Companion）、移动端 App、自定义模型渠道、双模型审查等功能，并修改了部分既有模块。改动清单见上文「本定制版的新增与改动」。
4. **协议与兼容**：本项目**不复制**官方压缩/混淆代码，**不接入**官方私有中继（relay）或账号后端，也**不声称**与官方协议兼容或通过官方认证。请勿将本项目描述为官方发行版或官方合作产品。
5. **名称与标识**：仓库中出现的 "ZCode" 名称、图标等仅用于说明代码来源与用途，不代表官方授权。

## 免责声明

1. **无担保**：本项目按「现状」（AS IS）提供，不附带任何明示或默示担保，包括但不限于适销性、特定用途适用性与不侵权担保。作者不对因使用或无法使用本项目而产生的任何直接或间接损失（含数据丢失、服务中断、设备损坏、收益损失）承担责任。
2. **自担风险**：本定制版包含**远程控制**能力，可让手机端对电脑上运行的 ZCode 发起有副作用的操作（创建任务、发送输入、停止执行、处理审批等）。使用前你应自行评估风险，务必只在**你自己的设备**与**你拥有合法授权**的环境上启用，并妥善保管配对码、令牌与服务器凭据。因误用、配置不当或凭据泄露造成的后果由使用者自行承担。
3. **不上传、不采集**：本项目不提供任何官方后端服务，作者不会收集你的数据。远控链路需你**自行搭建**服务器与网络环境，该环境中产生的日志、数据与流量由你自行管理并承担合规责任。
4. **合法使用**：使用者须自行确保其使用行为符合所在地区的法律法规、上游项目条款及第三方服务（模型供应商、云服务商等）的使用协议。**严禁**将本项目用于未经授权的入侵、监控、数据窃取或其他违法用途。
5. **模型与费用**：本项目可能调用第三方模型服务，相关账号、额度、费用与内容合规由使用者自行负责；本仓库不预置任何官方密钥或额度。
6. **与上游的关系**：本项目可能滞后于上游、包含上游尚未合并或已被移除的改动，也可能存在缺陷。请勿因本项目的问题向上游项目或官方团队追责。
7. **无维护承诺**：作者不承诺持续维护、及时修复或长期兼容任何上游版本。

> 若你不同意上述任一条款，请立即停止使用并删除本项目全部副本。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)（继承自上游）。
