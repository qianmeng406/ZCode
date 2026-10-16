# WSL 工作区第二阶段验收报告

日期：2026-10-16。源码基线：`253d39fc11032007f38c66b7b6cffe7e16143274`。在此基线上应用本阶段 RPC 修复与测试；不能将运行版本表述为完全未修改的基线。

规格：`wsl-workspace-acceptance.spec.md`。结构化证据与复跑入口：`wsl-workspace-acceptance-data/README.md`。机器相关驱动和大体积产物保留于 `C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase2`。

## 结论

**本机已完成标准部署 → 独立桌面 WSL 连接 → 真实 Agent 工具轮次 → 后台与取消 → 关闭重连的完整验收，具备 opt-in 试用条件。** 第八轮 WDIO 为 1 passing、退出码 0，结构化结果为 passed；测试结束后专属用户没有残留服务或回放进程。该结论覆盖本次固定环境和脚本化模型场景，不代表长期稳定性或全部模型兼容性验证。

| 项目 | 实测结果 | 证据 |
| --- | --- | --- |
| 本地资产来源与 SHA | 7 个组件核验通过 | asset-verification.json、provenance-summary.json |
| 空运行时首次标准部署 | 通过，21.18 秒，skipDeploy=false | first-deploy-result.json |
| 标准 RPC 文件、Git、真实 PTY、重连持久 | 12/12 通过 | standard-smoke-result.json |
| 连接取消、PTY 中断、断线回收、重连 | 5/5 通过 | lifecycle-final-result.json |
| 桌面首发、续发、Agent 后台输出与状态、Stop | 全部通过 | desktop-1792135327776-result.json |
| UI 连接中取消、关闭后同 identity 新 session、文件保留 | 全部通过 | 同上；WDIO 完整用例通过 |
| 测试结束后的专属用户进程与 replay 脚本 | 无残留 | final-cleanup-result.json |
| RPC 事件重订阅修复 | 基线 3 条失败，修复后 14 条通过 | rpc-regression-result.json、rpc-red.log、rpc-green.log |

第一阶段仍支持“Linux 本地派发热短命令约快 5 倍”的结论；不能据此声称完整 Agent 任务快 5 倍。源码、依赖和缓存应放在 WSL ext4，同一工作区的文件工具与 Bash 一起在 Linux 执行。Windows 保留桌面 UI，Windows 打包仍留在 Windows。

## 环境和资源

- Ubuntu-24.04，专属用户 `zcodewslp2`，uid 1001，密码锁定、无 sudo。工作区 `/home/zcodewslp2/workspace`，标准运行时位于其 `~/.zcode/server`；资源清单见 resources.json。
- 桌面构建、HOME、userData 和 E2E 产物均在独立 lab 副本。未覆盖主 Preview、主 dist 或 ftuser 的共享部署；未修改默认发行版、默认用户、WSL 配置、系统代理或防火墙，未执行 shutdown/terminate。
- 使用免费 Linux loopback replay，没有读取主实例 provider 凭据或调用付费模型。Agent 实际发出 HTTP 请求并执行工具；fixture 自测不替代真实桌面结果。
- server 单文件 SHA 为 `f41522627d1fc21394cf6d1aa2a514e43ee1245b09401f1e298b8c95f3f88025`；fresh Agent 单文件 SHA 为 `5626e48e6c8fb9b5a7a59b76dec2279494cb8244da5516951dafbe5b4dc49dc1`。glm 归档 SHA 为 `86629c9815367feebce3866a2a271aaf566b448404f92804cc341b97a61f7950`，其余六组件 source SHA 与原资产一致。
- Node 版本分别为 Windows 构建/驱动 24.11.0、Linux 标准部署 22.16.0、Linux replay 24.14.0；不宣称构建全程使用 mise 指定的 24.14.0。
- Agent 构建记录包含 2691 个输入文件哈希。开发态桌面还需要 browser-client.mjs、node-repl-host/dist、android/ios plugin dist；闭包见 desktop-generated-closure.json。
- Windows RPC 客户端包含本轮修复；Server/Agent 资产来源为上述基线构建，不声称所有已归档 bundle 都包含 RPC 补丁。

## 标准部署、RPC 和 PTY

通过公开 `createRemoteBackend` / `connectRemote` 路径部署，使用本地资产及 `local-download-upload`，没有跳过部署或手写替代握手。

| 测量 | 墙钟 |
| --- | ---: |
| 空运行时首次 connectRemote（含部署） | 21179.7 ms |
| 已装资产的 smoke 首连 | 17998 ms |
| smoke 再连 | 16189 ms |
| lifecycle 再连 | 17799.6 ms |
| smoke systemInfo / 文件写读 / PTY / Git | 115 / 36 / 94 / 108 ms |

首部署为单样本；两个显式再连样本为 16.2、17.8 秒，不声明稳定延迟或 P95。连接墙钟包含部署检测和握手，与第一阶段热命令计时分开。内存字段未取得有效数据，不作内存占用结论。

RPC 写入 `.zcodeignore` 后由真实 PTY 改写，再经 RPC 读回；cwd、分拆 marker、自然 exit=0 均有断言。Git 在本轮唯一子目录中验证摘要、未跟踪变更及 stage。PTY 先订阅再 write，避免快速输出早于 RPC write 返回；取消后复用同一个事件函数再次订阅，真实暴露并验证了下述 RPC 修复。

标准生命周期独立验证：detect 在途取消 774ms；PTY Ctrl+C 子进程退出约 515ms；断线子进程退出约 411ms；新 backend 重连文件保留。此处后台输出是 PTY shell 作业，Agent 后台状态另由桌面用例核验。旧 lifecycle-result/debug-result 保留为失败调试证据。

## 唯一产品修复：RPC 事件重订阅

同一 Event 函数取消最后一个监听器后，客户端删除了响应 handler；重新订阅只发送 EventListen，未恢复 handler，导致后续事件丢失。初始化前取消还会留下等待 Initialize 的旧激活回调。

`packages/rpc/src/channelClient.ts` 在每次激活时恢复 handler，以 activation generation 使旧回调失效；取消期间不投递事件。状态所有者与顺序见 `packages/rpc/specs/event-resubscribe.spec.md`。测试用同通道 barrier 调用刷新有序协议队列，不依赖固定 sleep。

隔离副本保留确定性红绿对照：基线 **3 failed / 11 passed**（两条重订阅、初始化前取消泄漏）；修复后 **14 passed**。整个 RPC 包 84 条测试通过，包含于最终相关集合 193 条中，不重复相加。这是本阶段唯一产品实现修复；其余变更为测试、驱动与文档。

## 桌面真实 Agent 验收

最终运行 `desktop-1792135327776`，runId `rmvan49lw`，artifact `desktop-e2e-20261016-072215-762`。WDIO 1 passing（用例 1m46.3s），退出码 0；结果 JSON 为 passed。

1. UI 在连接途中关闭向导并确认中止，检查没有建立 workspace tab 或新增 server。
2. 通过真实 WSL 向导选择发行版、用户与 ext4 工作区，核对 identity、remoteKind、active identity 和 session；tab 不持久化 secret。
3. 正式 Personal Config helper 把预置 provider 更新为 Linux replay endpoint，并读回断言；Agent 执行 Write → Bash 读取/校验/修改 → Read，最终双 marker 写入同一路径。
4. 同 taskId/sessionId 续发，通过 Bash 再读同一文件并完成模型响应。
5. Agent 后台 Bash：UI 从 running 到 completed，stderr/stdout 可见；真实 adapter stdout 日志含首尾 marker，完成文件落盘，子进程退出。
6. Agent 前台长命令：点击 UI Stop，等待 idle、stopRequested 清除、队列为 0，并核对 Python 子进程退出。最终两个受测 PID 为 1437、1476。取消以 UI 状态和 PID 为证，不能将尚未返回的 CANCEL tool_result 当作完成证据。
7. 真实悬停打开侧栏菜单并关闭工作区，侧栏项和 identity tab 消失；重新走向导，同 identity 建立全新 remoteSessionId `08a62048-cda4-4a6e-b156-b40b4320dc76`，读回文件内容完全一致。

最终只读观察中，该用户仅有观察命令自身的 sh/ps，replay 脚本目录无文件。**没有在关闭与重连之间单独采样旧 server PID 的退出时刻**；不将最终无残留扩大为逐关闭时序保证。标准断线回收已有独立 PID 断言。

历次失败均保留，最终通过没有覆盖历史结果：

| 轮次 | 结果及定位 |
| --- | --- |
| 1 | 缺开发态 browser-client 等生成产物，补齐部署闭包 |
| 2 | provider 仍指 Windows 端口而非 Linux replay；另有 WDIO 外层 120s 截断，改正式配置接线和 opt-in 预算 |
| 3 | 旧 mode helper 的 role=option 与现 UI menuitemradio 不匹配，复用 switchV4Mode |
| 4 | 首发通过，续发 Read 结果不含预期内容而回放拒绝；改为 Bash 真实再读文件。“缓存导致”未证实 |
| 5 | 受控用户名输入追加为 zcodewslp2zcodewslp2，修输入及 value 断言；WSL 代理警告不是根因 |
| 6 | 详情仍为 loading 即断言 running，改为等待真实状态 |
| 7 | Agent 四项全通过，侧栏动作需 hover 才挂载，补真实悬停 |
| 8 | 全链路通过，finally 及 WDIO 退出成功 |

Windows 对 Linux 同 loopback 的探测历轮有 true/false；Linux Agent 到 Linux replay 始终单独验证。本轮两个 probe 均 true，先前 Windows probe=false 的轮次也曾通过首发；不据此要求修改系统网络。

## 检查结果与适用限制

最终记录见 data/checks.json：相关单测 193 passed / 15 files，回放自测 21 项通过且自然 exit=0；代码格式、架构及 diff 检查通过。全仓 lint 最终 0 errors / 83 warnings；中间格式化曾使 smoke 脚本超行数上限，合并重复类型导入并内联仅使用一次的类型后复验通过。

全仓 typecheck **未通过**，仍为已知的 `packages/desktop/test/e2e/settings/fork-feature-acceptance.test.ts` 三处：L8 导入不存在的 sel（TS2305）、L54/L84 将 HTMLElement 传给要求 string 的接口（TS2769）。本轮未修改该文件，无新增类型诊断。不得把本阶段功能验收通过写成全仓检查全绿。

可在本机以 opt-in 方式继续使用“Windows 桌面 + WSL ext4 工作区”。标准连接仍约十几秒，尚未做 resident 优化、长期压力、多窗口并发、其它发行版/用户、断线任务恢复或真实外部模型矩阵验收；不支持据此承诺断线后任务继续。系统默认执行环境保持不变。

未提交、未推送。专属用户、资产与工作区保留供复跑；二进制和完整运行日志留在 lab，仓库只归档小型结果、检查摘要和 RPC 红绿日志。
