# 构建说明（发布包）

本文汇总本定制版产出**真实安装包**的完整构建要点、已知坑位与发布前核对清单。
日常开发命令见 [README.md](README.md) 的「开发与运行」；本文只讲**打包出可分发产物**这一段。

## 1. 产物清单

| 产物                          | 入口                                        | 输出位置                                                                                             |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Windows 桌面安装包（正式）    | `pnpm bundle:desktop`                       | `packages/desktop/dist*/ZCode-<版本>-win-x64.exe`                                                    |
| Windows 桌面安装包（预览）    | 同上 + `ZCODE_PREVIEW_IDENTITY=1`           | `packages/desktop/dist*/ZCode Preview-<版本>-...exe`                                                 |
| 远端运行时资源树（随包用）    | `pnpm prepare:local-remote-assets`          | `packages/desktop/dist-remote-assets-local/`                                                         |
| 远端 server bundle            | `pnpm --filter @zcode/server build`         | `packages/server/dist/remote/zcode-server.cjs`                                                       |

版本号统一取根目录 `package.json` 的 `version`（当前 `3.14.3`），
与远端资源树 `dist-remote-assets-local/releases/<version>/` 的目录名**必须一致**——
不一致时远端部署会找不到随包资源。

## 2. 工具链

- Node.js **24.14.0**、pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准（`mise install` 一键装齐）。
- 打包目标平台要在**同平台机器**上做：Windows 包要在 Windows 上构建，macOS 包要在 macOS 上构建。

## 3. Windows 桌面安装包（完整序列）

```bash
# 一次性：装依赖 + 准备运行资源
pnpm bootstrap:with-remote

# ① 正式身份（产品名 ZCode）
ZCODE_ENV=production \
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=config/provider/zcode-builtin.json \
ZCODE_DESKTOP_DIST_DIR=dist-new \
pnpm bundle:desktop -- --os win --arch x64

# ② 预览身份（产品名 ZCode Preview，可与正式版并排安装）
ZCODE_ENV=production \
ZCODE_PREVIEW_IDENTITY=1 \
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=config/provider/zcode-builtin.json \
ZCODE_DESKTOP_DIST_DIR=dist-new \
pnpm bundle:desktop -- --os win --arch x64
```

`bundle.mjs` 内部会自己跑 `prepare:runtime-assets`（agent bundle、远端资源裁剪、随包资源树），
不需要单独预跑；要跳过这步可用 `--skip-prepare`（**仅在确定资源已就绪时**）。

### 环境变量说明（逐个都是坑位，别省）

| 变量                                 | 作用                                                                  | 不设会怎样                                                                  |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ZCODE_ENV=production`               | 后端环境轴，决定连生产后端                                            | 落到 `test`，产物文件名带 `_TEST` 后缀，连测试后端                          |
| `ZCODE_PREVIEW_IDENTITY=1`           | 产品身份轴，决定 `productName` / `appId` / 安装目录名                 | 生产后端默认是**正式**身份，两个包会互相覆盖                                |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 内置渠道目录来源，固定指向仓库内 `config/provider/zcode-builtin.json` | 构建期可能用到别的配置路径，导致打包内容与仓库不一致                        |
| `ZCODE_DESKTOP_DIST_DIR=dist-new`    | electron-builder 输出目录，隔离正在运行的实例                         | 默认写 `packages/desktop/dist/`，与运行中的 `win-unpacked` 冲突（见坑位 3） |

> `ZCODE_PREVIEW_IDENTITY` **只接受 `1` 或 `0`/空**：写 `true`、`yes` 等其它拼写会在构建期直接抛错
> （与 CI YAML 路由层的精确比较保持同一套语义，防止 Preview 包误入生产验收目录）。

### 产物命名规则

- 产物名后缀只标记**后端环境**：`_TEST` 仅出现在测试后端的包上。
- **正式 / 预览靠产品名区分**：`ZCode-<版本>-win-x64.exe` vs `ZCode Preview-<版本>-win-x64.exe`，
  生产后端的 Preview 包没有额外后缀。
- 体积门禁：单个安装包上限 **500 MiB**（`audit-bundle-size.mjs` 自动校验）。
  随包远端资源约 165 MB（`node` 运行时占约 117 MB）已计入；`ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1`
  可去掉随包资源瘦身，但那样本地上传模式就没有资源可用（见坑位 6）。

## 4. 远端资源交付（随包 vs CDN）

远端工作区（SSH/WSL）要部署 server bundle、node 运行时、agent 运行时、pty、搜索工具。
**默认全走随包本地资源，零 CDN**；CDN 只在特定场景才需要。

### 4.1 随包本地资源（默认，零 CDN）

```bash
# 构建时自动执行（bundle.mjs → prepare:runtime-assets）；也可手动重建：
pnpm prepare:local-remote-assets                    # 默认只裁 linux-x64
pnpm prepare:local-remote-assets --platforms linux-x64,darwin-arm64
```

- 产出 `packages/desktop/dist-remote-assets-local/releases/<version>/`（扁平布局：
  `manifest-*.json`、`server/`、`node/<plat>/`、`node-pty/<plat>/`、`glm/<plat>/`、`tools/<plat>/`），
  经 electron-builder `extraResources` 打进 `<安装目录>/resources/remote-assets`。
- 部署时桌面端读本地文件 → SFTP 上传，**全程不发 CDN 请求**。
- **`ZCODE_REMOTE_CDN_PLATFORMS`（构建期，默认 `linux-x64`）决定哪些平台被打进包**。
  要给 `darwin-arm64` 等目标部署远端，构建时必须显式加进这个列表，否则装完包才发现缺资源。

### 4.2 运行时覆盖（不重打包换资源）

```bash
ZCODE_REMOTE_ASSET_LOCAL_DIR=<含 releases/<版本>/ 的目录>
```

指向任意同布局目录即可覆盖随包资源（排错/试新资源树时用）。**目录缺件会明确报错**，
不会静默回退官方 CDN——报错文案会提示是装包资源不完整还是这个变量指错了。

### 4.3 CDN 发布树（仅特定场景需要）

只有两种情况才需要自建 CDN 发布树：

1. 构建时设了 `ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1`（装包内没有随包资源）；
2. 想让 UI 的「远端服务器下载」模式也用 fork 产物（缺省拉 **ZCode 官方 CDN**，见 4.4）。

```bash
# 生成 CDN 布局发布树
node scripts/pack-remote-assets-cdn.mjs --platforms linux-x64
node scripts/pack-remote-assets-cdn.mjs --platforms linux-x64,darwin-arm64 --out <dir>
```

托管目录结构（见脚本注释）：`<out>/zcode/electron/releases/{<版本>/manifest-*.json, components/**}`，
其中 `components/<platformArch>/<id>/<version>.tar.gz` 是组件归档。

配套变量（**两个别混**）：

| 变量                              | 生效方式                                              | 语义                                                         |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `ZCODE_CDN_BASE_URL`              | **构建期烘焙**进 `__ZCODE_CDN_BASE_URL__`，也读运行期 | 自建 CDN 发布根地址，拼 `<base>/zcode/electron/releases/...` |
| `ZCODE_REMOTE_ASSET_CDN_BASE_URL` | **仅运行期**覆盖                                      | 完整覆盖地址，可带版本号；不带版本按当前版本推导             |

- 带版本/不带版本都能吃：解析层先试 `<base>/<version>` 再退回 `<base>`；已带当前版本的基址
  不会重复拼版本（避免 `.../0.2.10/0.2.10` 这种必然 404）。
- **公开仓库不要把个人服务器地址写进 `.env.production`**；放未跟踪的 `.env.local` 或环境变量。
- 本地资源解析优先级**高于** CDN 地址解析：`ZCODE_CDN_BASE_URL` 写错不影响本地模式。

### 4.4 「远端服务器下载」模式的缺省行为

不配置 CDN 地址时，该模式缺省拉 **ZCode 官方 CDN**（`https://cdn-zcode.z.ai`）的官方产物，
**不含本定制版的常驻运行等远端改动**；因此连接层会拒绝「常驻运行 + 远端服务器下载」组合。
想让该模式也用 fork 产物，按 4.3 自建发布树并配置地址。

### 4.5 构建后验收（零 CDN 链路复核）

```bash
npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl
npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl --distro Ubuntu-24.04
npx tsx packages/server/scripts/remote-local-assets-check.ts --ssh <host> --user <name> --password-file <file>
# 可选：--local-assets <dir>（默认 packages/desktop/dist-remote-assets-local）、--force
```

脚本把资源部署到真实 WSL/SSH 目标并跑完 **12 项**核对（本地资源树布局、远端平台 arch 匹配、
`deployServer` 完成、server bundle 与随包产物 **sha256 一致**、bundle 含 fork **常驻改动标记**、
远端 node 可执行、glm/pty/tools 落地、缺件 fail-fast 且错误指向本地资源树），并**统计两次
`fetch` 出网次数都应为 0**，证明确实零 CDN。

## 5. 已知坑位（踩过的都在这里）

### 坑 1：`app.asar` 里查中文/字符串要用大写 `\uXXXX` 转义

打包器把中文字符转成 **大写十六进制** 的 `\uXXXX`（例如 `\u6E20\u9053`）。
用小写转义或 UTF-8 字节去 `grep` 会得到**假阴性**，以为内容没打进去。
另：`grep -I` 会跳过二进制文件（asar 就是二进制），必须用 `Buffer.includes` 做字节级检查。
还要注意 asar 内的 **SHA256 integrity 哈希**里可能偶然包含你要找的子串，命中数多不代表内容在。

### 坑 2：Windows 任务栏 / 开始菜单图标变白纸

这是**老问题，会复发**，根因是：开始菜单快捷方式（`%APPDATA%\...\Start Menu\Programs\ZCode Preview.lnk`）
指向**已删除的旧构建目录**（比如 `packages\desktop\dist-current\win-unpacked\...`）。
Windows 按 AUMID（`dev.zcode.app.preview`）把运行中的窗口和该快捷方式绑定，取的是**快捷方式的图标**；
目标文件不存在 → 图标退化成白纸。

排查与修复：

```bash
# 1) 看快捷方式指向的目标是否存在
powershell -c "(New-Object -ComObject WScript.Shell).CreateShortcut(\"\$env:APPDATA\Microsoft\Windows\Start Menu\Programs\ZCode Preview.lnk\").TargetPath"

# 2) 把 target 指到当前构建产物的 exe（icon 取 exe 自身即可），然后重启 explorer.exe
#    —— 只改快捷方式不重启 explorer，任务栏仍显示缓存里的旧图标
```

**预防**：清理旧 `dist-*` 目录前，先确认没有快捷方式指向它；构建产物目录尽量固定
（见坑 3 的 `ZCODE_DESKTOP_DIST_DIR`），不要频繁换目录名。

### 坑 3：构建输出目录被运行中的实例占用

electron-builder 写 `packages/desktop/dist*/win-unpacked/` 时会覆盖 `ZCode Preview.exe`；
如果该 exe 正在运行，Windows 不允许覆盖 → 构建失败或留下半成品。
**要么先退出应用，要么用 `ZCODE_DESKTOP_DIST_DIR=dist-new` 把输出隔离到新目录。**
注意隔离后：开始菜单快捷方式仍指向旧目录，启动的是旧构建（图标/功能都是旧的），
装新包或改快捷方式后才算切换过来。

### 坑 4：同版本号重装会被当成「修复」

版本号没改就重打包，Windows 安装器视为**修复**而非升级，行为不一致时容易误判。
要让升级可区分，先改根 `package.json` 的 `version`（并同步 `dist-remote-assets-local/releases/<版本>/`）。

### 坑 5：远端资源版本目录与 `package.json` 必须一致

`prepare:local-remote-assets` 按 `package.json` 的 `version` 生成
`dist-remote-assets-local/releases/<version>/`。版本号改了但资源树没重建 →
运行时按新版本找目录、找不到 → 本地上传模式报「本地资源树缺件」。

### 坑 6：`ZCODE_SKIP_LOCAL_REMOTE_ASSETS=1` 的取舍

跳过随包资源能让安装包小约 165 MB，但**默认的「本地上传（随包资源）」模式将无资源可用**，
只能走「远端服务器下载」（拉 ZCode 官方 CDN 产物，不含本定制版远端改动，且不支持常驻运行）。
除非明确知道自己在做什么，否则别跳过。

### 坑 7：内置渠道目录改动要升 `revision`

`config/provider/zcode-builtin.json` 顶部的 `revision` 是目录版本号。
增删内置渠道后必须 `+1`（否则客户端缓存可能不刷新），
并跑对应测试确认 schema 与目录仍匹配。

## 6. 发布前核对清单

按顺序过一遍，全绿再分发：

1. **门禁**：`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check`，
   以及相关包测试。仓库没有统一的 `test` 聚合脚本，按包各自跑，
   直接用 `tsx` 跑各自的测试目录，例如
   `npx tsx --test packages/provider/test/*.test.ts`、`npx tsx --test packages/ui/test/*.test.ts`
   （UI 包测试需 `--tsconfig packages/ui/tsconfig.json` 才能解析 `@/` 别名）。
2. **产物存在且体积达标**：两个 `.exe` 都在，均 < 500 MiB。
3. **构建身份正确**：`ZCode-*.exe` 与 `ZCode Preview-*.exe` 同时产出，不互相覆盖。
4. **asar 内容抽查**（按坑 1 的方式查）：
   - 打包进去了该有的新功能字符串（用**大写** `\uXXXX` 转义或字节级查）；
   - 没有个人地址、token、`private/` 下的凭据、未跟踪的私有配置。
5. **随包资源树在位**：`win-unpacked/resources/remote-assets/releases/<版本>/` 存在；
   构建时若需要多平台远端部署，确认 `ZCODE_REMOTE_CDN_PLATFORMS` 已含目标平台（见 4.1）。
6. **零 CDN 链路复核**（见 4.5）：跑
   `npx tsx packages/server/scripts/remote-local-assets-check.ts --wsl`（或 `--ssh ...`），
   12 项全过、fetch 计数为 0 才算随包分发真的可用。
7. **记录 SHA-256**：`sha256sum *.exe`，与版本号一起留档。
8. **图标**（坑 2）：装完后任务栏/开始菜单图标是 Z 标而非白纸；
   图标不对先查快捷方式 target，再重启 explorer。

## 7. 远端 bundle

```bash
pnpm --filter @zcode/server build          # tsup + build:remote
```

产物为 `zcode-server.cjs` 等。
远端运行时资源树用 `node scripts/pack-remote-assets-cdn.mjs --platforms linux-x64`
生成 CDN 布局（仅在需要「远端服务器下载」也走 fork 产物时才做）。

## 8. 改了源码，什么时候需要重新打包

| 改动范围                                              | 需要重打包？                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `packages/ui` / `packages/web` / renderer             | 是（桌面包）                                                  |
| `packages/desktop` 主进程 / preload                   | 是（只影响桌面包）                                            |
| `apps/zcode-cli`（Agent 源码）                        | 是，且 `bundle.mjs` 会自动重建 agent bundle，无需手动预跑     |
| `packages/server`                                     | 桌面包内嵌的 server bundle 受影响则需重打；部署侧单独 `build` |
| `config/provider/zcode-builtin.json`                  | 是（记得升 `revision`，见坑 7）                               |
| 远端资源树 / 目标平台（`ZCODE_REMOTE_CDN_PLATFORMS`） | 是（重跑 `prepare:local-remote-assets` 后再 bundle，见 4.1）  |
| 纯文档 / 测试                                         | 否                                                            |

---

相关文档：[README.md](README.md)（功能清单与开发命令）、
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [NOTICE.md](NOTICE.md)（第三方声明；
声明生成脚本见 `scripts/licenses.mjs` / `scripts/generate-third-party-notices.mjs`）。
