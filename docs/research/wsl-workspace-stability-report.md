# WSL 工作区稳定性、并发与真实模型验收报告

日期：2026-10-16。承接 [第二阶段验收](wsl-workspace-acceptance-report.md) 和 [连接优化测量](wsl-connection-latency-report.md)。规格：[wsl-workspace-stability.spec.md](wsl-workspace-stability.spec.md)；证据与复跑：[data/README.md](wsl-workspace-stability-data/README.md)；使用说明：[wsl-workspace-opt-in.md](wsl-workspace-opt-in.md)。

## 结论

**本机 Windows 桌面 + Ubuntu-24.04 专属用户 + ext4 工作区已通过短时重复连接、共享安装根并发、双独立桌面实例及指定 step 模型工具轮次验收，可以 opt-in 日常试用。** 没有切换默认环境，没有启用 resident。30 轮循环约 4 分钟，不能据此保证过夜稳定性、内存无泄漏或完整 Agent 性能倍率。

| 验收项                                    | 结果                                                        | 证据                             |
| ----------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| 串行标准连接、RPC→PTY→RPC、下一轮文件持久 | 30/30 passed                                                | stability-result.json            |
| detect 中取消、真实长命令 Ctrl+C          | 各 6 次 passed，长命令 PID 退出                             | 同上                             |
| 同用户共享安装根的双连接                  | 5/5 轮 passed；关闭 A 后 B 继续文件/PTY                     | 同上                             |
| 双独立 HOME 桌面实例                      | 两边 WDIO exit 0，各 1 passing                              | desktop-pair-result.json         |
| B 退出后 A 的 UI 关闭重连及文件保留       | passed                                                      | A.peerExitedBeforeReconnect=true |
| WorkBuddy 反代 `cn:step-5-preview`        | 真实 Linux Agent Write→Bash→Bash→Read 全成功，26.769s       | step-real-proof.json             |
| 重复 loopback 探测                        | Linux 10/10，Windows forwarding 9/10                        | compatibility-result.json        |
| 其他通用发行版、其他用户、同应用双主窗口  | unavailable；默认用户解析 not-run                           | 同上矩阵                         |
| 最终资源回收                              | 本轮 server/Agent/replay/router 无残留；step 临时配置已删除 | cleanup.json                     |

运行时产品实现为 `2971ecb7` 加第二批小文件读取变更，该变更已整理为本地提交 `94175eeb`。桌面使用隔离副本的 host build；远端 server/Agent 资产沿用阶段二的本 fork 构建。构建 SHA 见前阶段 `desktop-readbatch-build-proof.json`，本轮三个测试接线文件的实测/当前 SHA 见 manifest.json。两个 helper 在执行后经 oxfmt 格式化，已审阅 diff，仅换行/尾逗号变化；不把两个不同 SHA 写成同一文件。

## 短时循环和连接成本

标准 createRemoteBackend→connectRemote 路径每轮新建 backend，没有 skipDeploy。安装锁前检查、锁内重检均保留；未跨锁复用旧读取。每轮 RPC 写 `.zcodeignore`，真实 PTY 读取、追加，再由 RPC 读回；下一轮验证上一轮内容。每 5 轮执行 detect 在途取消和 Python 90 秒长命令 Ctrl+C，并逐 PID 等待退出。

30 轮串行及后续 5 轮并发、最终持久性复核总计 **235.611 秒**。串行 30 个连接样本：

| 指标                             |    min | median | 样本 P95（nearest rank） |    max |
| -------------------------------- | -----: | -----: | -----------------------: | -----: |
| connectRemote                    | 4.838s | 5.054s |                   5.317s | 5.777s |
| disposeAndWait + backend dispose |   25ms |   28ms |                     36ms |   51ms |

释放耗时不含之后轮询 PID 消失的完整墙钟；PID 确认是独立断言。P95 仅描述这 30 轮探索样本，不是服务等级或跨机器性能保证。第二批优化的因果对照仍采用此前同场 N=10 的 **5.52→4.83s（12.45%）**；不能把本轮 5.05s 与旧对照混合计算收益。

5 轮并发中，每轮两方分别约 5.03–5.21s 和 8.16–8.26s 完成，符合共享安装根串行持锁重检带来的等待；没有为降低数字去掉锁。两个 server PID 不同，空间/中文目录的内容分离，关闭 A 后 B 继续 RPC/PTY，最终所观察的拥有 PID 全部退出。

## 资源观察的限制

每轮是新 server：RSS 为 178192–187868 KiB，fd 通常 25，首轮 26、一次 27，没有累积存活 server。Windows 测试驱动自身 RSS 从 **113.32 MiB 增至 133.85 MiB**（约 +20.52 MiB）。这是真实增长，不能写成“内存不增长”或“已证明无泄漏”。本轮没有强制 GC、堆快照或持续同一会话的过夜样本，无法区分缓存、分配器保留与泄漏；该观察不阻止固定环境 opt-in 试用，但不足以支持长期资源保证。

## 双桌面实例：保留首轮失败并明确配置边界

首轮两个独立 HOME 使用同一个 provider ID、不同的 Linux 回放端口。B 完成，A 的回放 requestLog 为空，A 助手只收到 `ok`，等待预期最终 marker 超时。失败记录 `desktop-pair-result-red.json` 保留。该症状与共享配置端点串用相符；没有保存当时的原始 Provider 配置或逐次写入时序，因此具体覆盖顺序属于推断，不伪造为逐写入观测。

源码确认 ProviderConfigRuntime 默认从远端用户 App 配置目录读取 Personal Config；provisioning target 以文件锁/CAS 更新该文件。**远端 Provider 配置属于用户级共享状态，不按连接隔离。** 两个客户端向同一 WSL 用户同步同 ID 的不同端点会覆盖。此处不改变产品所有权、不新增连接级配置分叉，日常并发应采用一致的 Provider 配置，配置不一致的独立客户端应使用不同 Linux 用户。

测试增加仅用于回放的 Linux loopback router，两个桌面同步相同入口，请求凭唯一 runId 转到各自 replay。router 只代理真实模型请求和 SSE，不生成工具结果；未知/多匹配 runId 拒绝。取消检查先用双端文件屏障完成，之后再正常连接，避免旧 before/after 全用户 PID 检查误判另一实例的合法 server。

修正轮：

- A/B 分别为 1 passing（1m13s / 1m4.2s），两个 WDIO exit 0；各自首发、续发、后台输出/状态、Stop、UI 取消和关闭重连通过。
- A 启动 `11:54:06.733Z`，B 启动 `11:54:06.747Z`；B 退出 `11:55:46.383Z`，A 等到 B 的运行进程退出屏障后继续关闭/重连，A 退出 `11:55:55.302Z`。两边不同 workspace identity 和新 remoteSessionId，文件保持一致。
- 两个 replay 的 Windows forwarding probe 均 false，Linux 均 true；完整 UI 仍通过。router 最后随 stdin EOF 退出并核对 PID gone。

这覆盖的是**两个独立应用实例**，不是同一 Electron 应用内两个主窗口。当前菜单没有 New Window，PrimaryWindowCoordinator 会复用已有主窗口；同应用双窗口记 unavailable，不为了验收新增窗口产品功能。A 在 B 退出后验证的是 UI 关闭/重连及文件读回；不扩大为“旧会话正在运行的模型任务跨窗口关闭保证继续”。

## 指定 WorkBuddy step 模型

用户指定的渠道定位为 `new-provider-2/cn:step-5-preview`，仅选择这一规则和模型。先有一次有界设计调用，随后通过隔离 Linux Agent CLI 运行真实工具轮次；设计回答包含不适用建议和截断，不作为验收结果。

真实轮次为 **Write→Bash→Bash→Read**，4 次 toolCall 按 ID 关联 scheduled、started、result，所有 result.success=true，顺序与完成事件均核验。独立读回 marker.txt，精确等于唯一 marker 加 `bash-seen`，最终 result.response 含 DONE marker；退出码 0、194 个事件、26.769s。

Provider usage 报告 5 次模型请求，inputTokens=75658、outputTokens=563、totalTokens=76221，其中 cacheReadTokens=29824。usage 是渠道返回值，不推算实际费用。凭据仅在内存和隔离私有文件中，临时 provider.json/builtin.json 已删除，data 目录未发现 Provider 文件；仓库不归档原始模型事件、请求、配置或服务地址。

真实模型在 Linux CLI Agent 中验收；桌面 UI 使用免费回放。**主会话模型没有被工具切换为 step**，不能把这次验收表述成整个编码会话都由 step 执行，也不能声称已经验收 step 的全部桌面 UI 场景。

## 环境矩阵与网络

可用通用发行版只有 Ubuntu-24.04；docker-desktop 不作为普通发行版。当前授权用户是 zcodewslp2，不借用共享用户、不改默认用户。因此其他发行版、其他用户均 unavailable，省略用户名的默认用户路径 not-run。空格、中文路径由并发文件/PTY 实测覆盖；含引号、空文件、尾换行等批量读保真由前批真实 WSL 测试覆盖。

独立 loopback server 重复 10 轮探测，Linux 10/10，Windows forwarding 9/10。没有修改代理、防火墙、`.wslconfig`，没有 shutdown/terminate。首次探测驱动的内联 Node 参数被 Windows→WSL 引号破坏，在启动层失败，保留 compatibility-startup-red.json；改为唯一临时文件传输后通过，该文件与目录已回收。

## 工程检查和交付边界

- 部署/WSL 回归 **148 passed / 8 files / 0 skipped**，包含新增批量读 34 项；RPC/连接取消/桌面会话边界另有 **176 passed / 14 files / 0 skipped**。两组本轮文件不重叠；不与历史第二阶段集合重复相加。
- 全仓 typecheck exit 0；lint **0 errors / 83 warnings**。阶段二报告里的三处类型错误已在前阶段本地提交修复，历史报告不回写成当时通过。
- 架构、格式、diff 检查结果见 checks.json；免费回放自测和新增 router 自测均通过。测试夹具验证不冒充桌面通过，真实桌面另有结果。
- 两批连接优化、稳定性/并发测试与文档按功能整理为本地提交。没有推送；只允许今后经用户明确批准后走 zcodefork 的正常 hooks，不能推 origin。
- 主 Preview、主 dist、共享用户数据及无关工作区改动保留。专属用户、标准安装根、合成工作区和隔离 HOME 保留供复跑；进程已退出。没有删除运行时制造冷启动，没有引入默认 WSL/resident 或恢复退役功能。
