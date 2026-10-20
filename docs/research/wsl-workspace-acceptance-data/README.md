# WSL 第二阶段证据与复跑

配套报告：[wsl-workspace-acceptance-report.md](../wsl-workspace-acceptance-report.md)。源码基线为 `253d39fc11032007f38c66b7b6cffe7e16143274`，运行桌面包含本阶段 RPC 修复及 opt-in 测试。结构化结果来自独立 lab；小型 RPC 红绿日志、回放自测输出与 checks 同时归档，不含真实凭据。

## 证据清单

| 文件                                                   | 内容                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| first-deploy-result.json                               | 空运行时标准首部署，21.18 秒，passed                                                                     |
| standard-smoke-result.json                             | 文件、Git、真实 PTY、重连持久，12/12 passed                                                              |
| lifecycle-final-result.json                            | detect 取消、PTY Ctrl+C、shell 后台输出、断线回收和重连，5/5 passed                                      |
| lifecycle-result.json、lifecycle-debug-result.json     | 两轮失败调试结果，保留不覆盖                                                                             |
| resources.json                                         | 专属用户、HOME、工作区及隔离边界                                                                         |
| asset-verification.json、provenance-summary.json       | 七组件核验、来源、版本和 SHA 摘要                                                                        |
| desktop-generated-closure.json                         | 开发态桌面所需四项插件生成产物                                                                           |
| rpc-regression-result.json、rpc-red.log、rpc-green.log | 基线 3 failed/11 passed，修复后 14 passed；含 barrier 确定性 pre-init 取消回归                           |
| desktop-1792133306853-result.json                      | 第三轮：mode helper 旧 role 不匹配                                                                       |
| desktop-1792133659192-result.json                      | 第四轮：首发通过，续发回放拒绝                                                                           |
| desktop-1792134434344-result.json                      | 第五轮：用户名受控输入追加，非代理/NAT 根因                                                              |
| desktop-1792134645913-result.json                      | 第六轮：后台详情 loading 即断言 running                                                                  |
| desktop-1792134924932-result.json                      | 第七轮：Agent 四项全过，关闭菜单未先 hover                                                               |
| **desktop-1792135327776-result.json**                  | **第八轮完整 passed**：首发、续发、后台、Stop、UI 连接取消、关闭重连、新 session 和文件保留；WDIO exit 0 |
| final-cleanup-result.json                              | 最终专属用户仅观察命令 sh/ps，无残留服务/回放脚本；不是逐关闭 PID 时序记录                               |
| replay-selftest.log                                    | 最终回放夹具 21 项 OK，SELFTEST_ALL_PASS，exit 0                                                         |
| checks.json                                            | 最终命令、退出码、测试数量和已知类型错误                                                                 |

大二进制（tar.gz、bundle、Node）、完整 E2E/Agent 日志及构建输入哈希保留在 `C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase2`。第一/二轮没有此处的桌面结构化 JSON，原始日志和 artifact 仍在 lab；报告保留其真实失败层级。

## 现有机器复跑（Git Bash）

以下命令使用本次保留的隔离环境。不能在主 Preview 或主用户数据目录运行独立验收；不能删除已安装运行时来伪造首部署。先阅读 lab 的 `phase2/reproduce.md`，核对资源清单、生成产物闭包和版本。

```bash
REPO='C:/Users/qianmengyys/Desktop/agent/ZCode-fork'
P2='C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase2'
LOADER="file:///$REPO/node_modules/tsx/dist/loader.mjs"

# 仅需要重建本地资产时使用；不下载官方 Agent 替换 fork。
node "$P2/prepare-assets.mjs"

# .mjs 入口仍会加载 TypeScript，因此显式使用 tsx loader。
node --import "$LOADER" "$P2/run-smoke.mjs"
node --import "$LOADER" "$P2/lifecycle.mts" \
  "$REPO" "$P2/assets" "$P2/lifecycle-final-result.json"

# 使用已构建的独立桌面；每次生成唯一 HOME 与 logs/desktop-<timestamp>-result.json。
node "$P2/run-desktop.mjs"

# 回放单元自测，不替代真实桌面工具验收。
node "$REPO/packages/desktop/test/e2e/fixtures/upstream/wsl-p2/wsl-p2-replay-selftest.mjs"
```

这些驱动的普通结果文件会更新；需要保留旧记录时先复制到唯一 run 文件名。此处归档的历史 JSON 不应被复跑结果覆盖。

`first-deploy.mts` 是独立的、仅供空运行时首次安装实验的脚本。当前保留用户已部署，不应再次执行或清空其 HOME。真正空 HOME、固定资产与隔离用户准备完成后，其调用形态是：

```bash
node --import "$LOADER" "$P2/first-deploy.mts"
```

它产出 first-deploy-result.json；run-smoke.mjs 不产出首部署结果。上面的 `--import` 参数是 **loader URL**，后一个参数才是脚本路径，不能把 .mts 脚本本身当 loader。

## 仓库入口与检查

- 规格：`docs/research/wsl-workspace-acceptance.spec.md`。
- 标准驱动：`packages/server/scripts/wsl-workspace-smoke.ts`。显式提供 `--distro`、`--user`、`--workspace`、`--mock-cdn-dir`、`--output`；本地路径需绝对路径，参数校验与平台 skip 均有测试。
- 桌面用例：`packages/desktop/test/e2e/conversation-session/conversation-session-wsl-workspace-acceptance-p2.test.ts`。仅 win32 且 `ZCODE_E2E_WSL_ACCEPTANCE=1` 时运行。所需环境变量由 lab run-desktop.mjs 显式设置；使用预构建副本前应同步最新测试和 RPC 修复并按 reproduce.md 重建。不要边运行边覆盖副本。
- RPC 回归：`packages/rpc/test/channels.test.ts`。红绿测试只在隔离副本暂换 baseline/fixed channelClient，不能覆盖主 repo 或运行中的 Preview。

最终相关集合从 repo 根目录运行：

```bash
pnpm exec vitest run packages/rpc/test \
  packages/server/test/wslWorkspaceSmoke.test.ts \
  packages/server/test/remoteConnect.test.ts \
  packages/server/test/wslBackend.test.ts \
  packages/desktop/test/e2eStartupCredentials.test.ts \
  packages/desktop/test/windowRemoteConnectionRegistry.test.ts \
  packages/desktop/test/desktopRemoteSessions.test.ts
pnpm lint
pnpm typecheck
pnpm architecture:check --changed
git diff --check
```

实测相关集合 193 passed / 15 files，其中 **wslBackend.test.ts 的 17 条确已命中并包含在 193 中**，不额外相加。最终 lint 0 errors/83 warnings、代码格式/架构/diff 通过；typecheck 仍有 fork-feature-acceptance.test.ts 三处既有错误，不能写为全仓绿。

## 结论边界

- 本机固定环境下完整桌面用例已通过，可以 opt-in 试用；不自动切换默认执行环境，不提交推送。
- 连接墙钟是十几秒、首部署单样本；不与第一阶段热命令比较，不声明连接 P95 或长期稳定性。
- 标准 stdio 断线会回收当前会话，不承诺断线任务继续或自动恢复。最终无残留不等于已逐次测量 UI 关闭后的旧 server 退出时刻。
- 真实 Agent 工具证据与 PTY shell 测试分别记录；fixture 自测通过不能冒充 Agent 执行通过。
- Windows loopback 转发 probe 仅记录实测。Linux Agent 与 Linux replay 的可达性单独验证，未修改系统网络。
