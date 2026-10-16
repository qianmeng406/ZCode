# 复跑说明

以下复现本轮实验方法。先阅读 [报告](../wsl-agent-benchmark-report.md) 中的范围和资源差异。所有目录均应为新建实验目录，禁止在带用户改动的工作区执行归档覆盖或索引重写。

## 1. 准备相同提交与工具链

固定提交：`253d39fc11032007f38c66b7b6cffe7e16143274`。

本轮 Windows 路径：`C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab`；Linux 路径：`/home/ftuser/zcode-agent-lab`。下面 `LAB` 指各侧实验根，`WORKSPACE` 指该侧干净源码副本，`BENCH` 指含本轮新增脚本的目录。脚本不是基线提交的一部分，需从当前研究改动单独复制到 Linux；不要覆盖主工作区。

- Windows 用 `git clone --local --no-hardlinks --single-branch --no-tags <repo> <new-copy>` 创建副本；Linux 用固定提交的 Git bundle clone 后 detached checkout。不要复制主实例配置、凭据或 node_modules。
- Windows local `core.autocrlf=false`；确认已经检出的文件也采用 Git blob 原始字节。本轮对自己新建的副本使用 `git archive HEAD` 解包重写，再 `git add --renormalize .` 刷新索引。必须确认 `git diff --cached` 与 `git status --porcelain` 都为空，HEAD 一致。
- Linux 源码与依赖放 ext4，不放 `/mnt/c`；Windows 副本放 NTFS。
- Node 24.14.0、pnpm 10.33.2、rg 14.1.1。工具装在实验目录，不修改系统默认版本。Windows Git 2.50.0.windows.2，Linux Git 2.43.0，差异记录在环境 JSON。
- 本轮 Node Linux x64 tar.xz SHA-256：`41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df`；Windows x64 zip：`313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66`。

依赖准备从各侧副本根执行（Node/pnpm 应解析到上述固定版本）：

```sh
pnpm --filter '@zcode/adapters...' --filter '@zcode/rpc...' install --frozen-lockfile --ignore-scripts
```

hoisted 工作区仍会安装较多平台依赖。记录网络/缓存条件与安装耗时；不要把准备时间混进命令样本。此命令未验证 Linux node-pty；本实验不覆盖桌面终端。

## 2. 打包公开执行适配器

两侧使用同一份 bundle。以下为本轮的打包方式，将脚本保存为实验目录内 `build-adapter.mjs`，用固定 Node 运行，传入干净副本路径和新 bundle 输出路径：

```js
import { build } from "<WORKSPACE>/node_modules/esbuild/lib/main.js";
import { resolve } from "node:path";
const [workspace, output] = process.argv.slice(2);
await build({
  entryPoints: [resolve(workspace, "apps/zcode-cli/packages/adapters/src/exec/index.ts")],
  alias: {
    "@zcode/contracts": resolve(workspace, "apps/zcode-cli/packages/contracts/src/index.ts"),
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
```

将 `<WORKSPACE>` 替换成实际绝对路径，Windows import 使用正斜杠。alias 指向 contracts 的公开入口，因副本没有预构建 contracts dist；没有访问其内部模块。副本已有可运行 dist 时，也可直接把公开 `dist/exec/index.js` 传给 CLI，但那属于另一种产物准备方式，应单独记录。

本轮 bundle：`exec-adapter.mjs`，SHA-256 `fd7ae520c31b7ac96370a10a2c0162552cfc94320ddbf6c7b89d496f272063dc`。复制到 Linux 后再次核验哈希。

## 3. 准备开发任务 JSON

保存以下脚本为实验目录内 `prepare-tasks.mjs`，用各侧固定 Node 执行 `prepare-tasks.mjs <WORKSPACE> <LAB>/dev-tasks`。两侧 task.file 必须分别指向各自 Node；不能在 Linux 调用 Windows node.exe。

```js
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const [workspace, output] = process.argv.slice(2).map((p) => resolve(p));
await mkdir(output, { recursive: true });
const base = { file: process.execPath, cwd: workspace };
const tasks = [
  {
    ...base,
    name: "rpc-tests-21",
    args: [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/rpc/test/buffer.test.ts",
      "packages/rpc/test/serialization.test.ts",
      "--maxWorkers=1",
    ],
  },
  {
    ...base,
    name: "rpc-typecheck-no-incremental",
    args: [
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/rpc/tsconfig.json",
      "--composite",
      "false",
      "--incremental",
      "false",
      "--noEmit",
    ],
  },
  {
    ...base,
    name: "rpc-compile-no-incremental",
    args: [
      "node_modules/typescript/bin/tsc",
      "-p",
      "packages/rpc/tsconfig.json",
      "--composite",
      "false",
      "--incremental",
      "false",
      "--outDir",
      join(output, "rpc-build"),
    ],
  },
];
await writeFile(join(output, "tasks.json"), JSON.stringify(tasks, null, 2));
```

## 4. 运行正式样本

以下是本轮最终调用。新复跑请把输出目录换成尚不存在的目录，以免覆盖原始结果。Windows 的 PATH 应保留 Git Bash 所需工具，但计时 Node 使用实验专属二进制。

Windows（Git Bash）：

```sh
LAB='C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab'
REPO='C:/Users/qianmengyys/Desktop/agent/ZCode-fork'
"$LAB/tools/node-v24.14.0-win-x64/node.exe" "$REPO/scripts/bench-agent-linux.mjs" \
  --workspace "$LAB/windows-workspace" \
  --output "$LAB/results/windows-final-2" \
  --shell 'S:/Git/usr/bin/bash.exe' \
  --git 'S:/Git/cmd/git.exe' \
  --rg "$REPO/packages/desktop/dist/win-unpacked/resources/tools/ripgrep/rg.exe" \
  --adapter-module "$LAB/exec-adapter.mjs" \
  --task-command-file "$LAB/windows-dev-tasks/tasks.json"
```

上面的 rg 是本机已有二进制的位置；另一台机器用同版本独立工具路径替换。默认样本数即 30/5/3。

Linux（在 Ubuntu Shell 内执行）：

```sh
LAB='/home/ftuser/zcode-agent-lab'
"$LAB/tools/node-v24.14.0-linux-x64/bin/node" "$LAB/bench-scripts/bench-agent-linux.mjs" \
  --workspace "$LAB/linux-workspace" \
  --output "$LAB/results/linux-final-2" \
  --shell /bin/bash --git /usr/bin/git \
  --rg "$LAB/tools/ripgrep/rg" \
  --adapter-module "$LAB/exec-adapter.mjs" \
  --task-command-file "$LAB/linux-dev-tasks/tasks.json"
```

`bench-scripts/` 包含入口及 `lib/bench-agent-linux-*.mjs`，应与 Windows 侧同哈希。直接从 Windows 发起 Linux 这一次命令亦可；计时循环依然在 Linux 内。Git Bash 调用 wsl.exe 时必须设置 `MSYS_NO_PATHCONV=1`，避免 `/bin/bash` 和 Linux cwd 被转换成 Windows 路径。

跨界对照（Windows Git Bash）：

```sh
MSYS_NO_PATHCONV=1 "$LAB/tools/node-v24.14.0-win-x64/node.exe" \
  "$REPO/scripts/bench-wsl-boundary.mjs" \
  --distro Ubuntu-24.04 \
  --workspace /home/ftuser/zcode-agent-lab/linux-workspace \
  --output "$LAB/results/wsl-boundary-final.json" --samples 30
```

此代码块里的 LAB/REPO 使用前面的 Windows 值。boundary 输出文件以 `wx` 创建，已有文件会报错。不要为测冷启动而停止其他 WSL 实例。

## 5. 校验并解读

- `failures` 必须为空；各场景 n 应满足 30/5/3，adapter-cold-init n=1。显式 adapter import 失败必须报错，不能把 skipped 当成完整成功。
- 检查 marker、cwd、超时/取消/后台探针、Git 状态、tracked 文件列表与输出落盘路径。
- 本轮完整源码 manifest 在实验目录 `results/{windows,linux}-source-manifest.json`。比较文件名、原始 bytes 与 SHA-256；symlink 比较目标文本。摘要保存在仓库 `comparison.json`。
- rg 输出按行排序并统一 CRLF/LF、路径分隔符后比较夹具结果；保留原始 SHA，不改写原始数据。多线程输出次序不必一致。
- 只比较同一层：shell 对 shell，adapter 对 adapter，task 对 task。不能用 Linux shell-native 2ms 宣称整个 Agent 2ms。
- 本轮首次安装时间、服务端准备和 VM 冷启动不是热态样本的一部分。

相关验证从研究改动所在仓库根执行：

```sh
node --test scripts/test/bench-agent-linux.test.mjs scripts/test/bench-wsl-boundary.test.mjs
pnpm lint
pnpm typecheck
pnpm architecture:check --changed
```

本轮全量 typecheck 存在报告所列基线错误。不要通过改动无关测试隐藏失败。

## 6. 独立连接探测与补充证据

本轮额外脚本保留于 Windows 实验根：

- `remote-probe/build-remote-lab.mts`：沿用固定提交的 server build options；产物与 input-hashes/metafile 位于 `remote-probe/built-from-253d/`。
- `remote-probe/probe-connect.mts`：WSLBackend + handshake + 5 项 RPC，自管目录启动，finally dispose；没有调用标准 deployServer。
- `source-manifest.mjs`、`verify-search-output.mjs`、`record-environment.mjs`、`verify-background-output.mjs`：输入、搜索结果、环境与后台落盘补查。

这些是本机隔离实验驱动，路径写死的远端探测脚本需要按环境调整；它们不属于产品 API。不能用本次结果声明标准部署、PTY、模型会话或 resident 已通过。完整实验目录保留用于审计/复跑，仓库仅收录小体积原始测量和证据摘要。
