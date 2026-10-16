# WSL 连接耗时分解与批量核对优化报告（阶段三）

日期：2026-10-16。规格：`wsl-connection-latency.spec.md`（测量）、`packages/server/specs/remote-deploy-batch-checks.spec.md`（优化）。数据：`wsl-connection-latency-data/`（baseline 与 after-batch 两轮同驱动 N=10）。

## 结论

warm 连接墙钟大头是 **deploy 幂等核对的串行 wsl.exe 往返**。批量核对（`existsMany` 一次往返替代逐文件 `exists`）后：

| 指标（warm N=10） | baseline | after-batch | 变化 |
| --- | ---: | ---: | ---: |
| **total median** | 16580ms | **6308ms** | **-62%** |
| deploy median | 15503ms | 5149ms | -67% |
| backend 调用数/连接 | 82 | 20 | -76% |
| 调用耗时合计/连接 | ~15.2s | 4.0s | -74% |
| detect / handshake / launch median | 604 / 406 / 70ms | 680 / 392 / 77ms | 基本不变 |

六段归因闭合（unattributedMs ≤2.5ms），语义由同驱动、smoke 与单测共同验证。

## baseline：93% 花在串行幂等核对

| 阶段 | n=10 min / median / max (ms) | 占比 |
| --- | --- | --- |
| total | 16383 / 16580 / 17700 | 100% |
| **deploy（幂等核对）** | 15320 / 15503 / 16559 | **~93%** |
| detect | 590 / 604 / 668 | ~3.6% |
| handshake | 378 / 406 / 424 | ~2.4% |
| launch | 65 / 70 / 83 | ~0.4% |

- 校准：`wsl.exe --exec true` steady 167–187ms（首调 2s 为服务冷启动）。每条 `exists`/`readFile` ≈ 一次固定往返。
- 82 次调用中约 60 条是官方插件闭包必需资产清单的逐文件 `exists`（zcodeAgentDeploy / zcodeAgentDevDeploy 的 `findMissingRemoteOfficialPluginAssetPaths`），另有两轮 `checkServerDeployDecision`（远端锁协议要求拿锁后重检，正确性约束，不删）。
- warm 口径：运行时已装；首装 21.18s 另计。n=10 < 20 不给 P95。

## 优化实现（最小修复）

- `IRemoteBackend` 新增可选 `existsMany(paths)`（与逐个 `exists` 同序同义）；`remoteExistsMany` 帮助函数在 backend 未实现时按原顺序串行 fallback——ssh/docker 行为不变。
- WSL 实现：每路径先走原 UNC 可达短路，剩余路径一次 shell 循环输出 Y/N 行；输出行数/取值非法即逐个 `exists` 退化。批量只做加速，不改变答案。
- 三个调用点改为批量：两处闭包清单循环 + `checkServerDeployDecision` 的 node/server 路径对。
- 未动：远端锁双轮重检协议、`readFile` 类核对、版本命令 exec（下一步候选）。

## after-batch 剩余成本（下一步依据）

deploy 5.1s / total 6.3s 的剩余去向（每连接 20 次调用）：

1. 两轮 `checkServerDeployDecision`（锁协议）：版本 exec ×2 + bundle markers + identity `readFile` ≈ 1.6s。
2. 工具核对：bfs/ripgrep/ugrep `.version` `readFile` ×3 + 可执行 `exists` ×3 ≈ 1.2s。
3. identity/元数据 `readFile`（glm.json ×2、server-bundle.json）与 zcode-agent/zcode.cjs/pty.node `exists` ≈ 1.0s。
4. detect 0.68s、handshake 0.39s、launch 0.08s（合计 ~1.1s，已接近协议下限）。

候选（按预期收益）：版本/identity 小文件批量 `cat`（一次往返）、工具核对跨组件合并、同连接内核对结果复用（两轮重检共享 pre-lock 轮的读取结果）。全部落地后 total 预期 ~2–3s；再往下需要 resident/预热（收益已不大）。

## 验证

- 新增 `remoteExistsMany.test.ts` 6 项（命令转义、Y/N 解析、非法退化、fallback 顺序、委托、空输入）；server 相关 61/61 通过，全仓 typecheck 0 错误。
- 标准 smoke 12/12（文件/PTY/Git/重连持久），行为不变；首连 8.1s / 重连 6.9s（原 18.0s / 16.2s，同步受益）。
- 同驱动 N=10 复测：调用数 82→20，total median 16.58s→6.31s；日志中闭包核对从 ~11s 空白降为一次批量（~1.1s 段）。

## 复跑

```bash
LOADER="file:///C:/Users/qianmengyys/Desktop/agent/ZCode-fork/node_modules/tsx/dist/loader.mjs"
node --import "$LOADER" C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase3/run-connect-latency.mjs 10
```

驱动与单测在 repo（`packages/server/scripts/wsl-connect-latency*.ts`、`packages/server/test/wslConnectLatency.test.ts`）；observer 仅包装计时，detail 脱敏。
