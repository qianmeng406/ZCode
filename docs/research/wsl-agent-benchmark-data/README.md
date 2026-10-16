# WSL Agent 基准原始数据

主报告：[第一阶段实测报告](../wsl-agent-benchmark-report.md)。方法与复跑：[reproduce.md](reproduce.md)。规格：[wsl-agent-benchmark.spec.md](../wsl-agent-benchmark.spec.md)。

## 本轮主结果

| 文件                                                                                                                            | 内容                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [windows.json](windows.json)                                                                                                    | 统一源码后的 Windows 正式轮；原始样本、场景、失败列表与探针                  |
| [linux.json](linux.json)                                                                                                        | 同版脚本在 Linux 内循环测量的正式轮                                          |
| [wsl-boundary.json](wsl-boundary.json)                                                                                          | Windows 逐命令跨 wsl.exe 的 30 个样本                                        |
| [comparison.json](comparison.json)                                                                                              | 自动汇总中位数/比值、完整源码 manifest 摘要、搜索等价验证、脚本 SHA-256      |
| [windows-environment.json](windows-environment.json) / [linux-environment.json](linux-environment.json)                         | 固定提交、版本、可见 CPU/内存、文件系统、干净 Git 状态与 adapter bundle hash |
| [remote-probe.json](remote-probe.json)                                                                                          | fresh server 握手、5 项 RPC、单次阶段时序、未覆盖项                          |
| [remote-build-info.json](remote-build-info.json)                                                                                | 固定提交的独立服务端构建与校验摘要                                           |
| [windows-background-output.json](windows-background-output.json) / [linux-background-output.json](linux-background-output.json) | 后台任务自然结束及 stdout/stderr 合并落盘验证                                |
| [checks.json](checks.json)                                                                                                      | 本轮检查状态、命令和已知基线限制                                             |

`windowsMs / linuxMs` 为耗时比值，不是完整 Agent 加速倍数。cold-init 只有 1 个样本，task 只有 3 个样本；不可拿这些样本的比值作稳定性/显著性结论。原始路径指向本机实验环境，供核对工作区和产物所有者。

## 完整实验材料位置

Windows：`C:/Users/qianmengyys/Desktop/agent/wsl-agent-lab`。
Linux：`/home/ftuser/zcode-agent-lab`。

Windows `results/` 保留初轮和最终轮、完整逐文件 manifest、搜索原始输出以及环境快照；Linux 对应目录保留原始输出与适配器落盘文件。Windows `remote-probe/` 保留构建脚本、输入哈希、metafile、fresh bundle、probe 脚本和日志。旧 ignored bundle 探测归档为 `result.old-bundle.json`，其来源一致性判断已由 fresh build 验证补齐。

本目录保存小体积测量数据和摘要，未纳入 node_modules、二进制工具、完整源码副本或模型凭据。实验资源尚未删除，便于复跑。没有修改默认执行环境，也没有验证标准部署、真实模型任务、PTY 或 WSL resident。
