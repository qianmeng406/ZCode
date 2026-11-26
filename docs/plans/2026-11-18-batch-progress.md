# 全批次实施方案 — 进度台账

> 对应《ZCode-fork 全批次实施总方案-20261111》74 个工作项。
> 基线：`7b4c9ef4`（v3.18.1），2026-11-18 开工。
> 状态词：待开始 / 进行中 / 阻塞 / 已实现待验收 / 已验收 / 证伪关闭 / 延后

## 总览

| 批次 | 主题                   | 项数 | 状态                          |
| ---- | ---------------------- | ---: | ----------------------------- |
| B0   | 准备、基线、规范与证据 |    6 | **已完成（性能基线除外）**    |
| B1   | 正确性、安全与工具契约 |    8 | **全部完成待验收**            |
| B2   | 现有 fork 功能稳定化   |   15 | 待开始                        |
| B3   | 性能与工程治理         |   13 | 待开始                        |
| B4   | Worktree 隔离          |    6 | 待开始                        |
| B5   | 多 Agent 绑定与路由    |    5 | 待开始                        |
| B6   | 权限、hunk、调度       |    7 | 待开始                        |
| B7   | 扩展能力               |    7 | 待开始（需逐项决定纳入/延后） |
| B8   | 集成验收与交付         |    7 | 待开始                        |

## B0 准备

| ID    | 项                   | 状态     | 备注                                        |
| ----- | -------------------- | -------- | ------------------------------------------- |
| B0-01 | 源码/环境/工作树快照 | 已验收   | 见 `2026-11-18-b0-baseline-and-evidence.md` |
| B0-02 | 问题证据台账         | 已验收   | 4 条证伪关闭，1 条失效入口                  |
| B0-03 | Spec 与架构准入      | 已验收   | 准入约束已实测                              |
| B0-04 | 测试夹具盘点         | 已验收   | B4/B6 依赖项待建                            |
| B0-05 | 性能基线             | **未测** | 需授权启动实例；不阻断源码验收              |
| B0-06 | 批次切片             | 已验收   | 本文件                                      |

## B1 正确性收口

| ID    | 项                         | 状态                         | 证据                                                                                                                                                               |
| ----- | -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1-01 | Oracle 裁决解析            | **已实现待验收**             | 否定 9 例误判 → 0；18 项 shared 测试绿                                                                                                                             |
| B1-02 | 深审只读与工作区边界       | **已实现待验收**             | **Glob `pattern` 越界（`../**`放行）已修**；新增`tests/deep-review-boundary.test.ts`（7 项）；Bash 写入/外部路径/命令替换既有防护经实测确认有效                    |
| B1-03 | 外部任务生命周期与 signal  | **已实现待验收**             | 新增任务级 `cancelled` 事实位；父 turn 取消不再误标成功任务                                                                                                        |
| B1-04 | 外部输出解析完整性         | **已实现待验收**             | `looksLikeStreamJson` 改为按驱动族事件集合判定；用户 JSON 正文不再被吞                                                                                             |
| B1-05 | Oracle 发现项解析          | **已实现待验收（重新界定）** | 原队列入口 `reviewQueue.ts` 已下线，改按仍存在的 `findings.ts` 验收：修掉 Windows 盘符截断（`C:\repo\src\a.ts:12`→`eposrca.ts`）、空格路径截断、无扩展名文件不解析 |
| B1-06 | 审查 baseline 与新仓库支持 | **已实现待验收**             | baseline 改为临时文件+rename 原子替换；无 HEAD 仓库退回未跟踪文件材料；`review-command.unit.test.ts` 此前不在 CLI test 脚本内，已接入                              |
| B1-07 | 持久化失败分级             | **已实现待验收**             | 绑定读取失败不再伪装成 unbound；新增 `external_agent.binding.read_failed` 事件                                                                                     |
| B1-08 | 工具可用性与提示词一致性   | **已实现待验收**             | 限流提示不再推荐无 handler 的 `ScheduleWakeup`；按可用工具集生成；6 项新测试绿                                                                                     |

## 变更集

| 日期       | 范围                            | 提交                                                                                            |
| ---------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| 2026-11-18 | B1-01~B1-08（8 项）             | `676bdc6b`（含 B0 台账/证据文档）                                                               |
| 2026-11-21 | 推送 + Preview 全量出包（验收） | `zcodefork/main`、`zcodefork/integrate/merge-upstream-v3.18.1` 均指向 `676bdc6b`                |
| 2026-11-22 | 上游同步 v3.18.2（非批次项）    | `1baed2ae`，基线由 `7b4c9ef4`（v3.18.1）升到 `fec97590`（v3.18.2）                              |
| 2026-11-26 | 上游同步 v4.0.0（进行中）       | `integrate/merge-upstream-v4.0.0`；冲突路径已全部解决并暂存；UI tsc 与定向测试通过；未提交/推送 |

### 上游同步 v3.18.2（2026-11-22）

不在 74 项范围内，但会改动所有后续工作项的基线，故在此登记：

- 上游增量：46 个文件（+1971/−171），凭据存储迁移修复、Linux 无 keyring 回退、
  start-plan CN 登录流、PowerShell 脚本加固、设置页模型供应商导航。
- 合并冲突仅 3 个文档；12 个双方都改过的文件自动合并后逐项核对了装配。
- 顺带修掉两个合并前就存在的阻断问题：TUI 的 `beta`→`fusion` 遗留（@zcode/tui typecheck
  3 处 TS2322）、上游新测试在 Windows 上的 `chmod 0600` 断言。
- 验证：core 5184 pass / shared 105 / services 27 / tui 219 / adapters 凭据 42 /
  desktop 相关 60 / bootstrap 定向 97；CLI 34 个包 typecheck 全绿；架构检查 0 违规。

### 上游同步 v4.0.0（2026-11-26，进行中）

- 上游基线：`a4b4445141eb7d3b3e99eada9292775383bfc44e`（tag `v4.0.0`，Source-Commit `acfaa5b7a5d245d5b84fbe37ef2c0d0748f97cdf`）；此前 fork 基线为 `v3.18.2` / `fec97590`。
- 上游增量约 2,209 个文件（+149,753/−24,801），243 个文件双方均修改；merge-tree 预估 71 处冲突。当前 71 个冲突路径已逐项融合、精确暂存，`git ls-files -u` 为零。
- UI 验证：`npx tsc -b packages/ui` 通过；4 组定向测试 9/9 通过。恢复 Composer 后台任务触发器，并以 `activityOpenRequest` 接通新的 activity capsule；保留唯一 workflow 详情直达。
- CLI 定向测试：`edit-tool-contract` 36/36、`subagent-background` 34/34、`runtime-memory-dream` 10/10 通过（core 专用 Vitest，单 worker）；contracts dist 已在 Zod 4.6.5 依赖下重建，`@zcode/core` 单包 typecheck 通过。尚未运行 CLI 全包 typecheck、全量 E2E 或发布验收。
- 出包验收（2026-11-27）：定向 UI 测试 4 文件 9/9 后，`pnpm dev:package --full` 最终 exit 0；生成 `packages/desktop/dist-preview-perf/win-unpacked`。`ZCode Preview.exe`（246,320,128 bytes，01:56）、`resources/app.asar`（471,996,019 bytes，01:56）、`resources/glm/zcode.cjs`（16,120,389 bytes，01:51）均为本次构建；产物目录与 exe 的 Windows 完整性标签均为 Medium。asar 可检出 `activityOpenRequest`；4 个平台的远程官方插件 seed 校验通过，Documents `visual-judge.md` 已进入 4.0.0 Linux ARM64 mock-CDN seed。未启动 Preview；无签名证书，跳过签名；`--dir` 无安装器，跳过体积审计。
- 出包期间修复两个阻断：合并曾删除仍属必需资源的 Documents/PDF/Presentations/Spreadsheets 四个 `agents/visual-judge.md`，已从 fork 第一父提交恢复；Windows GNU tar 在临时 cwd 位于仓库外时将 `C:/...` 归档路径当作远程主机，`scripts/prebuilt-binary-extract.mjs` 改为在 Windows 从归档目录以文件名解压，隔离冒烟通过。打包仍有 Node 24.11.0 与要求 24.14.0 的 engine warning；未运行 CLI 全包 typecheck、全量 E2E 或启动后交互验收。
- 合并提交 `ac268729` 已推送至 `zcodefork/integrate/merge-upstream-v4.0.0`；全量源码检查、CLI 全包 typecheck、E2E 与启动后交互验收仍未完成，因此本次同步尚不能标记为整体已验收。

### 出包验收（2026-11-21）

`pnpm dev:package --full`（exit 0，约 11 分钟）产出 `packages/desktop/dist-preview-perf`：

| 项                                            | 结果                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZCode Preview.exe` / `resources/app.asar`    | 16:49 重打                                                                                                                                                |
| `resources/glm/zcode.cjs`（CLI agent bundle） | 16:45                                                                                                                                                     |
| 修复入包自检                                  | `external_agent.binding.read_failed`（B1-07）、`envelopeTypes`/`CLAUDE_FAMILY_ENVELOPE_TYPES`（B1-04）、中文否定裁决词表（B1-01）均可在 bundle 中 grep 到 |
| 完整性标签                                    | exe 与产物目录均为 `Medium`（未继承 Low，可直接启动）                                                                                                     |
| 工作树                                        | 干净（node-repl-host dist-types 未弄脏）                                                                                                                  |
| 签名 / 安装器                                 | 无证书故跳过签名；`--dir` 无安装器产物，跳过体积审计                                                                                                      |
| 遗留清理                                      | 删除旧产物 `dist-preview-perf2`（2026-11-03，1.1 GB，无快捷方式引用）                                                                                     |

注：B1 各项仍为「已实现待验收」——上述仅为**产物层**核验（修复字符串确实打进 bundle），
交互层（GUI/真实进程）验收需另行授权启动实例。
