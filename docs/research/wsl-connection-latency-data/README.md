# wsl-connection-latency-data

配套报告：[wsl-connection-latency-report.md](../wsl-connection-latency-report.md)。规格：[wsl-connection-latency.spec.md](../wsl-connection-latency.spec.md)。

| 文件                                    | 内容                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| connect-latency-result.json             | **baseline**（批量核对前）warm N=10：每迭代六段归因 + 82 条 backend 调用明细（脱敏）+ wsl.exe 裸往返校准 + 聚合                                   |
| connect-latency-result-after-batch.json | **after-batch**（existsMany 批量核对后）warm N=10：total median 6.31s；旧 observer 仅记录 20 次调用，漏计 3 次 existsMany，不能把 20 当完整调用数 |
| connect-latency-control-readbatch.json  | **第二批同期对照**：产品仍为第一批优化后版本，observer 补齐批量方法；warm N=10，total median 5.52s，完整 API 调用数固定 23                        |

第二批新增证据：

| 文件                                                                    | 内容                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| connect-latency-result-after-readbatch.json                             | 第二批优化后 warm N=10，total median 4.83s，完整 API 调用数 19；对比同期对照 5.52s/23 次 |
| readfiles-real-red.json / readfiles-real-green.json                     | 真实 WSL 合成文本从全量 fallback 失败到 0 fallback 通过；返回内容与单项读取一致          |
| standard-smoke-after-readbatch.json                                     | 标准链路 12/12 passed，首连 5794ms / 重连 5931ms                                         |
| desktop-after-readbatch-result.json                                     | 新 remote 逻辑的隔离桌面完整验收 passed，Agent 工具/续发/后台/Stop/连接取消/关闭重连     |
| desktop-readbatch-source-sync.json / desktop-readbatch-build-proof.json | 八个同步源文件的前后 SHA、main/host 与包含新协议的压缩分块 SHA                           |
| cleanup-after-readbatch.json                                            | 最终专属 WSL 用户无残留 server/Agent/replay，仅观察进程 sh/ps                            |
| readbatch-checks.json                                                   | 148 项相关测试、全仓 typecheck/lint、架构、格式及桌面命令/结果摘要                       |

旧轮次数据保持原样；observer 漏计的更正在报告中说明，不伪造历史 JSON。新 observer 包装 `existsMany` / `readFiles`，每次批量 API 计一次，不代表底层进程数。

来源：lab `wsl-agent-lab/phase3/connect-latency-result.json`（由 `phase3/run-connect-latency.mjs` 产出）。驱动与单测在 repo `packages/server/scripts/wsl-connect-latency*.ts`、`packages/server/test/wslConnectLatency.test.ts`。

口径：warm 幂等部署（运行时已装），n=10 < 20 不给 P95；首装样本见 `../wsl-workspace-acceptance-data/first-deploy-result.json`（21.18s）。
