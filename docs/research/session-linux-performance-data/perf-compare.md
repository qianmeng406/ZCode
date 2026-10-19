# 会话执行环境：Linux 与 Windows 同尺性能对照（2026-10-18，已按产品实际 shell 校正）

## 方法

- **同一脚本**：`build/perf-round.py`。`--shell` 决定被测 shell，输出里带 `shellArgv` / `dialect`
  溯源字段，避免再出现"两半不同尺"的问题。
- **同一项目目录**：`session-linux-validation/perf-project`（NTFS）。
  Linux 侧经 `/mnt/c`（drvfs/9p）访问；Windows 侧为原生 NTFS 路径。
- **计时**：脚本进程内 `perf_counter`，每次采样新起一个 shell 子进程
  （等价「一条命令一个执行请求」），含子进程创建与 I/O，**不含** agent/模型调度，
  **不含**产品执行通道（RPC/lease）开销。
- 采样：热命令 n=30，连续 5 条 n=20，文件密集 5 轮取中位。

三列口径：

| 列               | shell                    | 说明                                                                                                 |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Linux            | `/bin/bash -c`           | WSL2 会话执行端实际形态                                                                              |
| Windows cmd      | `cmd.exe /c`             | **非产品 shell**，仅作参考（上一版本误用此列代表 Windows）                                           |
| Windows Git Bash | `S:\Git\bin\bash.exe -c` | **产品实际**：`shellProfile==="posix-bash"` 时解析 effective bash shell（`execution-command.ts:89`） |

产物：`build/perf-linux-round.json`、`build/perf-windows-cmd-round.json`、`build/perf-windows-round.json`。

## 结果（p50，ms）

| 指标                      | Linux（WSL2 `/mnt/c`） | Windows cmd（参考） | Windows Git Bash（产品实际） | GitBash ÷ Linux                          |
| ------------------------- | ---------------------- | ------------------- | ---------------------------- | ---------------------------------------- |
| 冷启动首条命令            | 2.66                   | 79.97               | 79.80                        | 30.0×                                    |
| 热短命令 `echo hi`        | **2.22**               | 13.69               | 59.52                        | 26.8×                                    |
| 目录列表                  | 12.01                  | 12.04               | 88.99                        | 7.4×                                     |
| 中文文件读                | 5.41                   | 11.25               | 84.19                        | 15.6×                                    |
| 连续 5 条（单进程）       | **2.45**               | 12.67               | 58.52                        | 23.9×                                    |
| 文件密集 100 文件写+读+删 | 598.28                 | **58.69**           | **59.30**                    | Linux 慢 10.1×（每文件 5.98 vs 0.59 ms） |

完整分布（mean/p95/min/max）见三个 JSON。

## 补充测量（`build/spawn-probe.py` 与 interop 探针）

**登录 shell**（产品在**没有 shell 快照**时的形态，`bash -l -c`，n=30）：
mean **494.57** / p50 **487.66** ms —— 单条近 0.5 秒。
代码里 `useLoginShell = shellInitSnapshot ? false : true`（`node-execution-adapter-process.ts:93`）
表明**首条走登录 shell、之后走快照非登录**（此点为读码推断，未逐条实测）。

**穿越成本**（从 Linux 会话直接起 Windows 进程，n=20）：

| 路径                                | mean  | p50   |
| ----------------------------------- | ----- | ----- |
| `cmd.exe /c echo hi`（经 interop）  | 36.70 | 36.38 |
| `bash.exe -c echo hi`（经 interop） | 80.02 | 77.10 |

扣除目标自身启动成本后，**过路费约 13–21 ms**，远低于历史 `wsl.exe` 每调直调（178.66 ms）。

## 结论

1. **每命令启动开销：Linux 占优约 24–27×**（Δ≈57 ms/条），对 cmd.exe 也有 5–6×。
   原因是产品在 Windows 侧用 Git Bash（其自身启动 ≈59 ms），而非 cmd（≈14 ms）。
2. **挂载盘上的文件元数据 I/O：原生 Windows 占优约 10×**（Δ≈5.4 ms/文件）。
   这是 9p 挂载的固定成本，不是 OS 差异；每文件 5.98 vs 0.59 ms。
3. 因此判据是**任务形状**，而且两侧量级差别很大：

| 情形                   | 优势方  | 每单位差量   | 回本点                                  |
| ---------------------- | ------- | ------------ | --------------------------------------- |
| 普通命令（spawn 主导） | Linux   | ~57 ms/条    | 需要 >98% 猜对率才值得"逐命令自选"      |
| 项目内大块文件操作     | Windows | ~5.4 ms/文件 | 穿越一次 13–21 ms → 约 3–4 个文件即回本 |

## 会话级决策表

| 会话主要做什么                                                      | 建议环境            | 依据                                  |
| ------------------------------------------------------------------- | ------------------- | ------------------------------------- |
| 大量短命令、多轮工具调用、小文件读改查                              | 本机 Linux          | 每条省 ~57 ms，累积可观               |
| 项目内大范围文件操作（全树 grep/find、构建、批量重写、大 git 操作） | 本机默认（Windows） | 每文件省 ~5.4 ms；万级文件差约 1 分钟 |
| 需要 Windows 专有工具（pnpm/node 装的 CLI、证书、注册表、GUI）      | 本机默认            | Linux 侧不存在（WSL 无 node，实测）   |
| 需要 Linux 专有工具链（apt、gnu 工具、bash 脚本）                   | 本机 Linux          | 反向同理                              |

## 口径限制（如实）

- 上述为**执行路径底噪对照**，不含产品通道（宿主反向 RPC、lease 校验）开销；
  产品通道对照见 `provenance/perf-benchmark.json`（历史受控数据）与 REPORT 第 4 节。
- Windows 半边由 WSL interop 启动，其自身子进程为原生 Windows 进程，计时不受启动方式影响；
  但**冷启动首条为单次采样**，且可能受 interop 后首次 DLL 加载影响，只作趋势参考。
- **文件密集用例的 I/O 由脚本进程自身完成，不经过 shell**，故 shell 选择不影响该项；
  该项对比的是"python 在 Linux 写 /mnt/c"与"python 在 Windows 写 NTFS"。
- 登录 shell 的 494.57 ms 是**裸登录 shell 启动**测量；产品是否每条都付这一成本取决于
  shell 快照缓存（见上"补充测量"）。
- 未测完整多轮 Agent 任务耗时（含模型/工具轮次），不构成任务级加速结论。
- **上一版（同日早些时候）的 Windows 列误用 `cmd.exe`**，把 Linux 的每命令优势低估为 5.6×；
  本版已按产品实际 shell 校正为 24–27×，并以 `shellArgv` 字段固化溯源。
