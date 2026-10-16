# WSL 稳定性与真实 step 验收证据

配套 [报告](../wsl-workspace-stability-report.md)、[规格](../wsl-workspace-stability.spec.md)、[使用说明](../wsl-workspace-opt-in.md)。固定环境：Windows / Ubuntu-24.04 / zcodewslp2 / ext4 HOME。产品部署客户端变更提交 `94175eeb`；远端资产来源沿用第二阶段本 fork 构建。

## 文件索引

| 文件                           | 内容                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| stability-result.json          | 30 轮串行、5 轮双连接、12 次取消、RSS/fd、逐拥有 PID 回收                          |
| desktop-pair-result-red.json   | 双实例首轮：同用户不同 Provider 端点竞争，A 失败、B 通过；不覆盖历史               |
| desktop-pair-result.json       | 共享 router + 取消屏障后，两边完整 WDIO passed；B 退出后 A 继续重连                |
| step-real-proof.json           | 指定真实模型完成事件、四个成功工具、独立文件读回、最终 marker、usage、临时配置清理 |
| compatibility-startup-red.json | 网络探测脚本内联参数引号被破坏，尚未进入探测层                                     |
| compatibility-result.json      | 10 次 Linux/Windows loopback、可用发行版/用户/窗口范围矩阵                         |
| cleanup.json                   | 最终无 server/Agent/replay/router 残留；凭据临时配置已删除                         |
| manifest.json                  | 原始归档 SHA、三个测试源码实测/当前 SHA、构建来源                                  |
| checks.json                    | 工程命令、退出码、数量、适用限制                                                   |
| drivers/\*.txt                 | 三个机器相关验收驱动的精确文本快照；防止误执行，保留 `.txt` 后缀                   |

不归档原始模型事件、provider JSON、HTTP 请求/header、服务地址、完整 WDIO/Agent 日志。桌面 requestLog 只留阶段布尔，工具清单已省略。manifest 的 SHA 对应最初归档字节；不要格式化或覆盖历史结果。

## 当前机器复跑（Git Bash）

机器相关驱动仍保留在 lab。三个快照包含固定机器路径，不能在其他机器直接运行；需要先按第二阶段资源准备说明建立对应隔离环境。它们把结果写到脚本同目录，因此也不要直接在本证据目录执行。

```bash
REPO='C:/Users/qianmengyys/Desktop/agent/ZCode-fork'
LAB='C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab'
P4="$LAB/phase3/phase4"
LOADER="file:///$REPO/node_modules/tsx/dist/loader.mjs"

# 每次结果会更新；复跑前将旧结果另存为唯一文件名。
# 本驱动要求专属用户没有其他正在跑的 server，勿与双桌面测试同时执行。
node --import "$LOADER" "$P4/stability.mts"

# 只启动唯一 Linux loopback 观察进程，最后关闭 stdin 并回收自身文件。
node "$P4/compatibility.mjs"

# 已构建的隔离副本，最新 pair helper/spec/router 必须同步后再运行。
# 不覆盖主 Preview。结果要求 A/B exit 0 + passed，router 退出。
node "$P4/run-desktop-pair.mjs"
```

驱动 `stability.mts` 通过公开 `createRemoteBackend`/`connectRemote`，不 skipDeploy；运行前需可用的本 fork 本地资源目录 `phase2/assets`。含空格/中文工作区位于本轮 mktemp 下，目录保留供复查；进程生命周期在 finally 释放。

双桌面脚本以 `phase2/desktop-workspace` 为 cwd，执行现有 WDIO WSL P2 spec。测试副本的依赖 `@zcode/server` 必须指向副本 server 源码，host 构建应包含第二批 readFiles；重建与版本核验见此前连接优化数据里的 source-sync/build-proof。测试接线只改 spec/helper/fixture，不需要重新构建远端 Server/Agent 归档。

如需从仓库手动配置 pair 而非保留驱动，先在 Linux 专属目录启动 `wsl-p2-pair-router.mjs`（`ZCODE_WSL_PAIR_ROUTER=1`、stdin 保持打开），读取其动态端口；分别设置两个 WDIO 进程：

| 配置                                               | 取值                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| `ZCODE_E2E_WSL_ACCEPTANCE`                         | `1`                                             |
| `ZCODE_E2E_HOME_DIR` / `ZCODE_E2E_WSL_RESULT_FILE` | 两个不同的隔离 Windows 绝对路径                 |
| `ZCODE_E2E_WSL_DISTRO` / `ZCODE_E2E_WSL_USER`      | 显式发行版与专属用户                            |
| `ZCODE_E2E_WSL_WORKSPACE_PATH`                     | 各自唯一 Linux A/B 绝对路径                     |
| `ZCODE_E2E_WSL_LINUX_NODE`                         | 专属 Linux Node 可执行文件路径                  |
| `ZCODE_E2E_WSL_PAIR_ROUTER_PORT`                   | 两边相同的 router 动态端口                      |
| `ZCODE_E2E_WSL_PAIR_BARRIER_DIR`                   | 本轮唯一、初始为空的 Windows 屏障目录，两边相同 |
| `ZCODE_E2E_WSL_PAIR_LABEL`                         | 分别 `A` / `B`                                  |

保留驱动还显式设置本地资产、免费 replay 模式、dummy key、SKIP_BUILD 和固定调试端口关闭。B 的 WDIO 运行进程退出后，调度器在屏障目录写 `B-exited`；A 才进行关闭重连。不得伪造这个文件绕过等待。没有 pair 变量时原有单实例 P2 路径保持原样。

## 免费检查入口

```bash
node packages/desktop/test/e2e/fixtures/upstream/wsl-p2/wsl-p2-pair-router-selftest.mjs
node packages/desktop/test/e2e/fixtures/upstream/wsl-p2/wsl-p2-replay-selftest.mjs
pnpm exec vitest run packages/server/test/remoteDeploy.test.ts \
  packages/server/test/remoteDeployLock.test.ts \
  packages/server/test/runtimeToolDeploy.test.ts \
  packages/server/test/remoteExistsMany.test.ts \
  packages/server/test/wslConnectLatency.test.ts \
  packages/server/test/remoteReadFiles.test.ts \
  packages/server/test/wslBackend.test.ts \
  packages/server/test/wslReadFiles.test.ts
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
git diff --check
```

相关集合148条，不与第二阶段193条直接相加，因为有重复文件。router 自测覆盖注册、端口/冲突拒绝、并发 SSE 透明转发、未知/歧义拒绝、无交叉路由；这不替代真实桌面通过。

## 真实模型与费用边界

真实模型结果来自 lab `run-step-agent.mjs` 与 `extract-step-proof.mjs`；这两个涉及读取指定私有规则的机器脚本不归档。重跑真实模型会产生费用，不能把它加入默认单测/无人值守循环。

原轮次已获用户明确授权，只取 WorkBuddy `new-provider-2/cn:step-5-preview` 的规则，在唯一 Linux 私有目录（700）生成 600 配置并向 Agent 传递**文件路径**，不传 key 命令行、不复制整套 provider。真实 Agent 使用现有隔离入口，限定 cwd 内合成 Write/Bash/Read；结束删除临时 provider.json/builtin.json。脱敏 proof 按 toolCallId 关联成功完成、独立读取文件、最终 result marker 与 usage。只做 HTTP 问答不满足此判据。

主会话模型未切换；该真实模型证据属于 Linux CLI Agent，桌面用免费 replay。其他发行版/用户、同应用双主窗口、过夜持续会话、真实模型的全部取消/后台场景没有被此次结果覆盖。推送仍需单独批准，本轮未推送。
