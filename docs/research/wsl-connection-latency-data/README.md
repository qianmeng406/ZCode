# wsl-connection-latency-data

配套报告：[wsl-connection-latency-report.md](../wsl-connection-latency-report.md)。规格：[wsl-connection-latency.spec.md](../wsl-connection-latency.spec.md)。

| 文件 | 内容 |
| --- | --- |
| connect-latency-result.json | warm N=10 完整结果：每迭代六段归因 + 82 条 backend 调用明细（detail 已脱敏）+ wsl.exe 裸往返校准 + 聚合统计 |

来源：lab `wsl-agent-lab/phase3/connect-latency-result.json`（由 `phase3/run-connect-latency.mjs` 产出）。驱动与单测在 repo `packages/server/scripts/wsl-connect-latency*.ts`、`packages/server/test/wslConnectLatency.test.ts`。

口径：warm 幂等部署（运行时已装），n=10 < 20 不给 P95；首装样本见 `../wsl-workspace-acceptance-data/first-deploy-result.json`（21.18s）。
