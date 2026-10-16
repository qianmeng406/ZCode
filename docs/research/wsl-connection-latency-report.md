# WSL 连接耗时分解报告（阶段三首步）

日期：2026-10-16。规格：`wsl-connection-latency.spec.md`。数据：`wsl-connection-latency-data/`（lab `wsl-agent-lab/phase3/connect-latency-result.json` 同源）。

## 结论

**warm 连接 16.4–17.7 秒中，93% 花在 deploy 幂等核对：每连接 82 次串行 wsl.exe 远端往返（exists/readFile 逐文件检查），单条 ~170–240ms，与裸 `wsl.exe --exec true` 校准中位数 177ms 一致。** 不是握手慢、不是 Node 冷启动慢、不是 RPC 装配慢。

| 阶段 | n=10 min / median / max (ms) | 占比 |
| --- | --- | --- |
| total | 16383 / 16580 / 17700 | 100% |
| **deploy（幂等核对）** | **15320 / 15503 / 16559** | **~93%** |
| detect | 590 / 604 / 668 | ~3.6% |
| handshake | 378 / 406 / 424 | ~2.4% |
| launch | 65 / 70 / 83 | ~0.4% |
| wrap / runtimeNetwork | <1 | ~0% |
| unattributed | ≤1.4 | ~0% |

- 校准：`wsl.exe --exec true` 5 次，steady 167–187ms（首调 2073ms 为 wsl 服务冷启动）。
- 每迭代 backend 调用 82 次，调用耗时合计 14.8–15.9s ≈ deploy 段墙钟，解释完整。
- systemInfo RPC ~100ms，dispose ~48ms。
- warm 口径：运行时已装、幂等跳过上传；首装 21.18s 另计（first-deploy-result.json）。n=10 < 20，不给 P95。

## 82 次往返的构成（单次连接，72 种路径）

1. **glm Agent 闭包逐文件核对 ~60 条**：`~/.zcode/server/agents/glm/packages/*/…` 的 plugin.json、SKILL.md、文档、vendor 资产等逐个 `exists`；同一 vendor 文件被重复检查 4–9 次（如 `visualize/assets/vendor/manifest.json` 9 次/连接、`vendor/floati…` 4 次/连接）。
2. **两轮重复的 "checking if deploy needed"**：node exists、server exists、版本 readFile 各查 2 遍（完全相同的两轮）。
3. **工具版本核对**：bfs/ripgrep/ugrep `.version` + 可执行文件 exists、node-pty prebuild、glm 制品 SHA 标记文件。
4. 启动/握手只占末段 2 次 exec（`~/.zcode/server/zcode-server.cjs` spawn ~64ms + handshake ~400ms）。

deploy 日志中 glm 检查前的 ~11–12s"空白"即这些串行逐文件往返的累计，不是本地构建或哈希计算。

## 优化方向（按数据决策，不在本步实施）

优先级依预期收益排序：

1. **批量核对（首选）**：把 N 条 `exists`/`readFile` 合并为一次远端命令批量返回（82 次往返 → 2–5 次）。预期 deploy 15.5s → <0.5s，**连接总墙钟 → ~1.5s**（detect 0.6 + batched deploy ~0.3 + launch 0.07 + handshake 0.4）。
2. **去重**：同路径重复检查（4–9 次/文件）合并为一次；两轮相同的 deploy-needed 检查合成一轮。
3. **缓存**：本地记录上次核对指纹（版本+清单哈希），未变化时跳过全量逐文件核对。
4. **resident/预热**：handshake+launch 仅 ~0.5s，前三项落地后常驻的边际收益很小，应后置。

上述均为产品改动（deploy 核对路径），实施前按治理规则先写状态所有者与时序 spec 并补回归测试；完成后用同一驱动复测对比。

## 复跑

```bash
LOADER="file:///C:/Users/qianmengyys/Desktop/agent/ZCode-fork/node_modules/tsx/dist/loader.mjs"
node --import "$LOADER" C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab/phase3/run-connect-latency.mjs 10
```

驱动与单测在 repo（`packages/server/scripts/wsl-connect-latency*.ts`、`packages/server/test/wslConnectLatency.test.ts`，7 tests passed）；observer 仅包装 backend 计时、console 时间戳捕获日志标记，不改连接语义。detail 脱敏有单测覆盖。
