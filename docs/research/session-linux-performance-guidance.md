# 会话 Linux 执行环境：提示词性能建议的数据依据

本文记录 `# Session Execution Environment` 提示词里性能数字的来源、适用条件和边界。
数字是**同机实测**结果，不是产品承诺；基准或挂载方式变化时需要同步更新提示词常量。

## 适用范围

该特性把 Windows 项目目录通过 WSL 的 `/mnt/c` 映射给 Linux 执行端，**不是** ext4 原生工作区。
因此：

- 本文只采用 `/mnt/c` 映射下测得的数字；
- [wsl-agent-benchmark-report.md](wsl-agent-benchmark-report.md) 的 ext4 结果（热命令约 5×）
  **不能**套用到本特性；
- 文件密集操作在 `/mnt/c` 上会受 9p/drvfs 往返开销影响，与 ext4 结论相反。

## 实测数据

来源（同机、项目位于 Windows 盘、经 `/mnt/c` 映射）：

- 已归档快照：[session-linux-performance-data/](session-linux-performance-data/)（含文件哈希与条件）
- 原始实验目录：`wsl-agent-lab/session-linux-validation/REPORT.md` §4、
  `provenance/perf-benchmark.json`、`build/perf-{linux,windows-cmd,windows}-round.json`

p50，单位 ms：

| 场景                         |           WSL Linux (`/mnt/c`) |       Windows cmd | Windows Git Bash | 相对结论                           |
| ---------------------------- | -----------------------------: | ----------------: | ---------------: | ---------------------------------- |
| 冷启动首个命令               |                           2.66 |             79.97 |            79.80 | Linux 约 30× 快于 Git Bash         |
| 热短命令 echo                |                           2.22 |             13.69 |            59.52 | Linux 约 26.8× 快于 Git Bash       |
| 产品通道热 echo（mean）      |                           7.01 | 36.27（本地通道） |                — | 产品通道约 5× 快于 Windows 本地    |
| 目录列举                     |                          12.01 |             12.04 |            88.99 | 约 7.4× 快于 Git Bash，与 cmd 持平 |
| CJK 文本读取                 |                           5.41 |             11.25 |            84.19 | 约 15.6× 快于 Git Bash             |
| 连续 5 轮短命令              |                           2.45 |             12.67 |            58.52 | 约 23.9×                           |
| 100 次小文件写读删           |                     **598.28** |         **58.69** |        **59.30** | **Linux 慢约 10.1×**               |
| 登录 shell `bash -l -c echo` |                         487.66 |                 — |                — | 每命令约 0.5 s，必须避免           |
| 每命令 `wsl.exe` 包装        | 178.74（另一组 median 107.48） |                 — |                — | 比 Windows 原生更慢                |
| typecheck（非增量）          |                          ≈1.0× |                 — |                — | 无稳定差异                         |
| compile（非增量）            |                          ≈1.0× |                 — |                — | 无稳定差异                         |
| RPC 单测 21 项               |                          1.18× |                 — |                — | n=3，弱证据                        |

其他原始数据：

- 登录 shell：`build/spawn-probe.py`，mean 494.57 / p50 487.66（n=30）。
- 每命令 `wsl.exe`：`provenance/perf-benchmark.json`，178.66 mean / 178.74 p50；
  另有 `docs/research/wsl-agent-benchmark-data/wsl-boundary.json` 的 107.48 median（不同测量层）。
- 产品通道：`wslChannel` 热短命令 7.01 mean / 6.78 p50；windowsLocal 36.27 / 35.93。

## 限制

- 非严格单变量实验：Git/CPU/内存可见量、宿主负载与缓存状态不同；未清页缓存。
- 目录/文件密集数字受 `/mnt/c` 映射影响；**不能**外推到 ext4 或其它发行版。
- 依赖安装耗时因缓存条件不同，不能用于安装性能结论。
- 样本量：短命令/登录 shell 为 30，构建类为 3，RPC 单测为 3；只作方向性参考。
- 未覆盖：完整 Agent 任务、模型生成、桌面 UI、PTY/终端、标准部署与重连。
- 比率不代表整机或整轮对话加速。

## 对应的提示词结论

`apps/zcode-cli/packages/core/src/context/sections/session-execution.ts` 中：

1. 短命令优先合并成少量调用（WSL 明显快于 Windows Git Bash）；
2. 目录列举/文本读取更快，但避免在 `/mnt/c` 做文件密集循环，批量操作合并到一个进程；
3. 构建/typecheck 不承诺加速；
4. 禁止 `wsl.exe` 嵌套与每命令登录 shell；
5. 不安装系统包、不覆盖 `node_modules`。

本地（非 WSL）会话不注入该段。数据更新时同步修改提示词常量与本文。
