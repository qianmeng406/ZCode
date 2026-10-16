# Windows 桌面 + WSL 工作区 opt-in 使用说明

本机已验收 Ubuntu-24.04、专属用户 zcodewslp2、ext4 HOME。完整结果与限制见 [稳定性报告](wsl-workspace-stability-report.md)。这是手动选择现有 WSL 工作区的路线；本轮没有改变默认执行环境。

## 日常进入工作区

1. 在桌面新建任务的工作区选择入口打开远程连接，选择 WSL。
2. 显式选择发行版和 Linux 用户。本机实验环境为 Ubuntu-24.04 / zcodewslp2；不要省略用户后意外进入共享默认用户。
3. 连接成功后在目录浏览器中选择 `/home/zcodewslp2/workspace` 下的项目。源码、node_modules、Git 元数据和构建缓存放在 Linux HOME/ext4；`/mnt/c` 跨文件系统路径不在本次性能结论内。
4. 使用当前桌面的模型配置同步能力配置远端 Agent，先做一个小任务核验文件写入与 Bash 读回。远端运行的是 Linux 工具；Windows 专用程序、签名和 Windows 打包留在 Windows。
5. 不需要时通过工作区侧栏菜单关闭。当前验收按 stdio 会话语义：断开会回收本轮 server/Agent/子进程，不承诺断线任务继续或自动恢复。重新连接使用同一目录，文件会保留，会话连接 ID 会更新。

标准安装根为所选 Linux 用户的 `~/.zcode/server`，不同目录共用该用户的安装根及部署锁。已有运行时的标准连接本机约 5 秒；首次安装、网络、资产更新与其他进程持锁会延长。第一阶段热短命令约快 5 倍不能当作完整 Agent 任务快 5 倍。

## 并发与 Provider 配置

多个工作区可以共用同一个 Linux 用户，但 **Provider Personal Config 是用户级共享状态**。两个客户端用同一个 provider ID 同步不同 endpoint/key 时会相互覆盖。独立客户端应保持相同的 Provider 配置，或使用各自已准备好的 Linux 用户；窗口/连接/workspace identity 不隔离该用户级配置。

本次桌面并发用两个独立 HOME 应用实例进行，免费回放统一通过测试专用 Linux loopback router。该 router 只用于验收，不是日常代理部署方式。当前 UI 没有公开的同应用 New Window 入口，同应用双窗口未验收。

WorkBuddy 反代 `cn:step-5-preview` 的真实 Linux Agent Write/Bash/Read 已通过，桌面 UI 使用免费回放验收；两项证据范围分别记录。真实服务地址、API key 和 provider 配置不能放进仓库、命令行参数或日志。

## 常见问题定位

| 现象                         | 优先核验                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 连接报用户/发行版不存在      | `wsl.exe --list --quiet`、显式 distro/user；不要为修复测试而改默认用户                                                         |
| 首连慢、提示安装或等待       | 当前资产是否更新、标准安装根是否可写、另一连接是否持锁；不能删共享运行时来“加速”或制造冷启动                                   |
| 能连接但模型请求去错端点     | 同一 Linux 用户的 Provider 同步是否被另一个客户端改写；先统一配置再试                                                          |
| Windows localhost 偶发不可达 | 分别核验 Windows 和 Linux 端。Linux Agent 的 localhost 是 Linux；本机 forwarding 10 次只有 9 次成功，不能依赖 Windows 转发保证 |
| 文件工具/Bash 看到不同文件   | 核对 Linux 绝对路径、实际 cwd、所选用户与 workspace identity；不要只看同名目录                                                 |
| 关闭后任务中止               | 当前 stdio 会话的预期边界；本轮没有启用 resident/断线续跑                                                                      |
| Windows 专用依赖构建失败     | 在 Windows 构建，Linux 工作区不等价于 Windows 运行环境                                                                         |

本轮不修改 `.wslconfig`、系统代理、防火墙，不执行 WSL shutdown/terminate。共享用户或其他发行版不在本次覆盖范围；不要把环境探测不通直接归因产品问题。

## 可复跑验收

详细入口及显式环境变量见 [证据与复跑](wsl-workspace-stability-data/README.md)。运行前核对固定资产、隔离桌面副本、独立 HOME 和专属用户。不要把 E2E 指向主 Preview、主 HOME 或他人的项目，不要执行含真实 key 的示例。

30 轮验收只持续约 4 分钟；Windows 驱动 RSS 有约 20.52 MiB 增长，尚未做堆快照或过夜验证。可以据当前证据试用，不能据此认定内存无泄漏、跨发行版兼容或所有模型场景已完成。
