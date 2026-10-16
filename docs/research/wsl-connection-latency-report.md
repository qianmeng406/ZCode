# WSL 连接耗时分解与批量核对优化报告（阶段三）

日期：2026-10-16。规格：`wsl-connection-latency.spec.md`（测量）、`packages/server/specs/remote-deploy-batch-checks.spec.md`（优化）。数据：`wsl-connection-latency-data/`（baseline 与 after-batch 两轮同驱动 N=10）。

## 结论

warm 连接墙钟大头是 **deploy 幂等核对的串行 wsl.exe 往返**。批量核对（`existsMany` 一次往返替代逐文件 `exists`）后：

| 指标（warm N=10）                   |         baseline |                 after-batch |                 变化 |
| ----------------------------------- | ---------------: | --------------------------: | -------------------: |
| **total median**                    |          16580ms |                  **6308ms** |             **-62%** |
| deploy median                       |          15503ms |                      5149ms |                 -67% |
| backend API 调用数/连接             |               82 | 23（原 observer 仅记录 20） |                 -72% |
| 旧 observer 记录的调用耗时合计/连接 |           ~15.2s |            4.0s（漏计批量） | 不作完整 IO 成本比较 |
| detect / handshake / launch median  | 604 / 406 / 70ms |            680 / 392 / 77ms |             基本不变 |

六段归因闭合（unattributedMs ≤2.5ms），语义由同驱动、smoke 与单测共同验证。

## baseline：93% 花在串行幂等核对

| 阶段                   | n=10 min / median / max (ms) | 占比     |
| ---------------------- | ---------------------------- | -------- |
| total                  | 16383 / 16580 / 17700        | 100%     |
| **deploy（幂等核对）** | 15320 / 15503 / 16559        | **~93%** |
| detect                 | 590 / 604 / 668              | ~3.6%    |
| handshake              | 378 / 406 / 424              | ~2.4%    |
| launch                 | 65 / 70 / 83                 | ~0.4%    |

- 校准：`wsl.exe --exec true` steady 167–187ms（首调 2s 为服务冷启动）。每条 `exists`/`readFile` ≈ 一次固定往返。
- 82 次调用中约 60 条是官方插件闭包必需资产清单的逐文件 `exists`（zcodeAgentDeploy / zcodeAgentDevDeploy 的 `findMissingRemoteOfficialPluginAssetPaths`），另有两轮 `checkServerDeployDecision`（远端锁协议要求拿锁后重检，正确性约束，不删）。
- warm 口径：运行时已装；首装 21.18s 另计。n=10 < 20 不给 P95。

## 优化实现（最小修复）

- `IRemoteBackend` 新增可选 `existsMany(paths)`（与逐个 `exists` 同序同义）；`remoteExistsMany` 帮助函数在 backend 未实现时按原顺序串行 fallback——ssh/docker 行为不变。
- WSL 实现：每路径先走原 UNC 可达短路，剩余路径一次 shell 循环输出 Y/N 行；输出行数/取值非法即逐个 `exists` 退化。批量只做加速，不改变答案。
- 三个调用点改为批量：两处闭包清单循环 + `checkServerDeployDecision` 的 node/server 路径对。
- 未动：远端锁双轮重检协议、`readFile` 类核对、版本命令 exec（下一步候选）。

## after-batch 剩余成本（下一步依据）

deploy 5.1s / total 6.3s 的剩余去向（旧 observer 记录 20 次调用，遗漏 3 次 `existsMany`，完整口径为 23 次 API 调用）：

1. 两轮 `checkServerDeployDecision`（锁协议）：版本 exec ×2 + bundle markers + identity `readFile` ≈ 1.6s。
2. 工具核对：bfs/ripgrep/ugrep `.version` `readFile` ×3 + 可执行 `exists` ×3 ≈ 1.2s。
3. identity/元数据 `readFile`（glm.json ×2、server-bundle.json）与 zcode-agent/zcode.cjs/pty.node `exists` ≈ 1.0s。
4. detect 0.68s、handshake 0.39s、launch 0.08s（合计 ~1.1s，已接近协议下限）。

候选：版本小文件批量读取、工具核对合并、同一持锁调用内消除冗余 IO。**更正：不得在两轮重检间共享 pre-lock 读取结果**，另一个进程可能在等待锁期间更新部署目录。此前 ~2–3s 仅是未验证的估计，不能作为可达性能承诺，也不能据此判断 resident 的收益。第二批先限定为工具核对，保留双轮重检与 Agent identity 语义。

## 验证

- 新增 `remoteExistsMany.test.ts` 6 项（命令转义、Y/N 解析、非法退化、fallback 顺序、委托、空输入）；server 相关 61/61 通过，全仓 typecheck 0 错误。
- 标准 smoke 12/12（文件/PTY/Git/重连持久），行为不变；首连 8.1s / 重连 6.9s（原 18.0s / 16.2s，同步受益）。
- 同驱动 N=10 复测：total median 16.58s→6.31s；日志中闭包核对从 ~11s 空白降为一次批量（~1.1s 段）。旧 observer 未包装 `existsMany`，因此旧数据的 20 只是被记录调用数；补齐后同一产品版本实测固定 23 次 API 调用。原始 JSON 不回写，墙钟结论不变。

## 第二批：工具版本读取与 binary 核对合并

本批只修改运行时工具核对，不复用锁前结果、不修改 Agent identity。三个工具的 `.version` 合并为一次 `readFiles`，版本匹配的 binary 合并为一次 `existsMany`，仍按原顺序安装必要工具并写版本。

重新测量第一批优化后的版本作为同期对照，避免把机器状态变化（旧轮次 6.31s，本次对照 5.52s）误算为代码收益。两组各 warm N=10，全部成功，n<20 不给 P95。

| 指标                               |              同期对照 |               第二批优化后 |               变化 |
| ---------------------------------- | --------------------: | -------------------------: | -----------------: |
| total median                       |                5517ms |                     4830ms | -12.5%（约 687ms） |
| total min / max                    |         5394 / 5803ms |              4682 / 5491ms |       探索样本范围 |
| deploy median                      |                4462ms |                     3726ms |             -16.5% |
| backend API 调用/连接              |                    23 |                         19 |                 -4 |
| 工具核对 API 调用                  | 3 readFile + 3 exists | 1 readFiles + 1 existsMany |                6→2 |
| detect / handshake / launch median |      577 / 404 / 66ms |           576 / 397 / 64ms |           基本不变 |

归因差额全部计入 `unattributedMs`（本批两组最大 1.58ms），API 调用数不是 wsl.exe 进程数，也不代表每个 exec 进程的完整执行时长。

批量读取按路径返回字符串或 null（单文件读取失败），空文件保持空字符串。WSL 保留 UNC 优先；shell 批量用 base64 隔离换行和分隔符，脚本通过八进制 literal 传输，避免 Windows→WSL 多层引号被破坏。批量协议/命令异常会退化为原单项读取，未实现批量接口的 backend 继续串行读取。元数据只在本次持锁调用内预取，不形成跨连接缓存。

真实 WSL 合成文件验证先发现“内容正确但全量退化”的失败（5 次 fallback），修复脚本传输后通过：5 个路径覆盖空文件、引号/空格、Unicode/末尾换行、BOM/CR/NUL 文本、长文本和缺失文件，与单项读取一致，且 **0 次 fallback**。只清理本次 mktemp 创建并核对过的目录。该接口沿用现有 WSL 文本解码规则，不是通用二进制读取接口。

标准 smoke **12/12 passed**，首连 5794ms、重连 5931ms；这些是独立单次验收数据，不能替代上表十轮性能样本。

最终相关测试 **148/148 passed（8 files）**，其中新批量读取/工具核对测试 34 项（18+9+7）；全仓 typecheck exit 0，lint 0 errors / 83 warnings，架构 0 violations。详见 `wsl-connection-latency-data/readbatch-checks.json`。

独立桌面 **1 passing（1m46.1s），WDIO exit 0**：run `desktop-1792146385325`，结构化 result passed；包含 Agent Write→Bash→Read、续发、后台输出/状态、UI Stop 子进程退出、连接取消、关闭后同 identity 新 session 重连与文件保留。免费 Linux 本地回放，没有调用真实外部模型。结束后专属用户仅有观察命令 sh/ps；这是最终无残留检查，不声称逐次关闭 PID 时序。

桌面仅同步八个 remote 源文件并重建隔离 main/host 等进程产物，核验 host 压缩分块包含新协议，所有同步源文件哈希仍与主仓库一致；已验 SHA 的远端 server/Agent 资产保持原版本。第一次构建校验因中文字符串压缩成转义形式而未匹配，未启动 WDIO；改用稳定协议标记验证分块后才启动上述成功验收，不把构建校验失败算作桌面测试失败。

剩余成本仍集中于部署的其他元数据/版本核对。本批实测 4.83s，没有证据支持承诺 2–3s。下一步优先补长期稳定性、并发和其他发行版矩阵；真实外部模型测试需要独立授权，不能用免费回放替代其结论。

## 复跑

```bash
LOADER="file:///C:/Users/qianmengyys/Desktop/agent/ZCode-fork/node_modules/tsx/dist/loader.mjs"
node --import "$LOADER" C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase3/run-connect-latency.mjs 10
```

驱动与单测在 repo（`packages/server/scripts/wsl-connect-latency*.ts`、`packages/server/test/wslConnectLatency.test.ts`）；observer 仅包装计时，detail 脱敏。
