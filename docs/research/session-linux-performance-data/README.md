# 会话 Linux 执行环境性能原始数据

本目录是 [session-linux-performance-guidance.md](../session-linux-performance-guidance.md)
所引用数据的归档快照，原始实验目录为
`wsl-agent-lab/session-linux-validation/`（仓库外，未入库）。

## 文件

| 文件                          | 内容                                                           | SHA-256                                                            |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `perf-benchmark.json`         | 产品通道 / Windows cmd / 每命令 `wsl.exe` 三路对比（mean/p50） | `e1afc72922107d0c1d3c699ffb074aa9a1d9bfc818b6efff256938e5ca565f87` |
| `perf-linux-round.json`       | Linux (`/mnt/c`) 原始均值/分位与文件密集场景                   | `c227b141c48e89abb2890b83e7a6aa73bef8e7335541f5732578636b001d5a1e` |
| `perf-windows-round.json`     | Windows Git Bash（产品本地通道）对照                           | `b52c69cd522045408fc0690cd1147919f0da8bb5b93ff51cdf7a32510b7075bb` |
| `perf-windows-cmd-round.json` | Windows cmd 对照                                               | `e5b564688c51efa2b930a12bad7d85a69ba89f6fdbb13dcd4bc307738045da88` |
| `perf-compare.md`             | 实验执行者的对比说明                                           | `0cbf4da043cee2f631587224e0b1710d5f766eaaec04c99c36402351a00deaa9` |

## 条件

- Windows 项目位于 NTFS，经 WSL 的 `/mnt/c` 映射；**不是** ext4 原生工作区。
- 短命令 n=30，构建类 n=3；未清页缓存，非严格单变量实验。
- 数字仅用于相对方向与提示词建议，不是产品性能承诺。

## 更新

重新跑基准后同时更新本目录文件、上表哈希和
`session-linux-performance-guidance.md`，并检查
`apps/zcode-cli/packages/core/src/context/sections/session-execution.ts`
中的提示词数字是否需要同步。
