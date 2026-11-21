# B0 开工基线、证据台账与批次切片

> 对应《ZCode-fork 全批次实施总方案-20261111》B0-01 — B0-06。
> 本文件是可提交的工程记录，不含用户数据或凭据。
> 编制：2026-11-18

## B0-01 源码、环境与工作树快照

| 项           | 值                                                                    |
| ------------ | --------------------------------------------------------------------- |
| HEAD         | `7b4c9ef430391491e7d906a275d46a8c6e996338`                            |
| 分支         | `main`（跟踪 `zcodefork/main`）                                       |
| 工作树       | clean（`git status --porcelain` 空）                                  |
| 产品版本     | `3.18.1`（根 `package.json`）                                         |
| 上游比较基线 | 官方 v3.18.1 = `c5904686`（`origin/main`）                            |
| 上次发布同步 | `integrate/merge-upstream-v3.18.1` = `7b4c9ef4`（与 main 同）         |
| Node         | 运行时 **v24.11.0**，`mise.toml` 声明 **24.14.0**（见下「环境偏差」） |
| pnpm         | 10.33.2（与 mise 一致）                                               |

### 基线漂移（相对方案编写时的 `0be413ca`）

方案写于 2026-11-11，当时基线 `0be413ca` / v3.17.2；此后 **55 个提交**，其中包含：

- 上游合并到 v3.18.1（`34d4bee2`），随后补回 5 处被合并吃掉的运行时逻辑（`0fc34c7d`）
- Beta → 融合模式（`9d7c834e`）、ApplyPatch 归还上游休眠（`de3e5a01` / `46765ff9`）
- Oracle 审查面板移除「待审」区（`be9a17d4`）
- 主控提示词层三处修正（`a6890099`）

**结论**：方案正文对任何文件行的引用都可能失效，实施时以核验结果为准，不以方案行号为据。

### 环境偏差（影响验收可信度）

| 项    | 声明       | 实际                     | 影响                                                                                                 |
| ----- | ---------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Node  | 24.14.0    | 24.11.0                  | 打包时 pnpm 报 `Unsupported engine` 警告；本轮实测未出现由它引起的行为差异，但结论不能等同于声明版本 |
| CMake | 未记录前置 | 4.4.4 便携版（用户目录） | 全量出包必需，见 `zcode-fork-cmake-install` 记忆                                                     |

## B0-02 问题证据台账

标签：**F** 源码事实｜**H** 待验证假设｜**D** 设计决策｜**V** 已验证（须附命令与结果）。

| ID    | 条目                         | 标签       | 状态         | 证据 / 关闭标准                                                                                                 |
| ----- | ---------------------------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| B1-01 | Oracle 否定裁决被判 pass     | **F + V**  | 已修复待复验 | 修复前实测 20 例中 9 例误判 pass（含「未通过/不能通过/无法通过」）；修复后 0 例。命令见下                       |
| B1-05 | 审查发现项与位置解析入口     | **F**      | 入口已不存在 | `packages/ui/src/v4/oracleReview/reviewQueue.ts` 在 `be9a17d4` 被有意删除（待审区下线）。方案该条需重新界定范围 |
| B1-05 | 指纹规则需版本兼容           | **H**      | 未验证       | 待核对 `packages/shared/src/oracle-review/findings.ts` 现有指纹实现与 baseline 兼容性                           |
| B1-03 | `start()` 返回 taskId 是 bug | **已证伪** | 关闭         | 方案 1.2 已撤回；`external-agent.port.ts` 明确为异步句柄契约                                                    |
| B1-02 | `$HOME` 绕过深审边界         | **已证伪** | 关闭         | 方案 1.2 已撤回；只保留全链路防御测试要求                                                                       |
| B2-11 | 输入预测已成主轮附带         | **已证伪** | 关闭         | 当前仍是独立辅助链路（`INPUT_PREDICTION_QUERY_SOURCE`）                                                         |
| B3-01 | 九个性能开关默认关闭是 P0    | **已证伪** | 关闭         | 属现存保守契约，需 A/B 与语义等价测试后单项推广                                                                 |

### B1-01 复现与验证命令

```bash
# 失败用例（修复前应红）
node node_modules/vitest/vitest.mjs run packages/shared/test/oracleReviewShared.test.ts

# 真实解析器探测（读 dist，必须先重建 shared）
cd packages/shared && npx tsc -p tsconfig.json && cd ../..
node <probe.mjs>   # 20 个样例：修复前 9 例误判 pass，修复后 0 例

# 调用方回归（UI 共享同一结果）
node node_modules/vitest/vitest.mjs run packages/ui/test/oracleReview.test.ts
```

## B0-03 Spec 与架构准入

| 模块            | 现有 spec                                             | 本次是否需更新                            |
| --------------- | ----------------------------------------------------- | ----------------------------------------- |
| Oracle 裁决解析 | `packages/shared/src/oracle-review/verdict.ts` 头注释 | 是（否定优先级已写入代码注释，spec 待补） |
| 外部 Agent 执行 | `docs/design/v2/loop/` 与 `external-agent-*.md`       | 按 B1-03/B2-01 启动时更新                 |
| 会话执行环境    | `docs/research/session-linux-execution.spec.md`       | 按 B2-06/B2-09 启动时更新                 |
| Worktree        | 无（B4 新增）                                         | 启动时新建                                |
| 写协调          | 无（B4-04 新增）                                      | 启动时新建                                |

架构准入约束（已实测）：`zcode-cli` 与 `shared` 均为 `managed: false`，新文件必须落在 managed 模块内，否则 pre-push 报 `unmanaged-new-file`。优先复用已有文件而非登记新模块。

## B0-04 测试夹具现状

| 设施                 | 位置                                                      | 状态                                        |
| -------------------- | --------------------------------------------------------- | ------------------------------------------- |
| 外部 CLI fake        | `apps/zcode-cli/packages/core/tests/` 内既有 fixture      | 可用（`subagent-background-fixture.ts` 等） |
| 内存 FS              | `apps/zcode-cli/packages/core/tests/memory-test-utils.ts` | 可用，注意只按 `/` 切前缀（Windows 需归一） |
| 记录型 session store | `runtime-output-token-continuation-test-helpers.ts`       | 可用                                        |
| 确定性时钟           | core 测试 fixture 内 `now` 注入                           | 可用                                        |
| 临时 Git 仓库        | 未系统化                                                  | 待 B4/B6 建立                               |

## B0-05 性能基线

**当前状态：未执行**。按方案要求需用户授权启动测试实例后才能采集。测量方案要点：

- 指标：TTFT、输入可用时间、帧/commit 耗时、事件处理 p50/p95、CPU、heap/RSS、轮询数、队列高水位
- 同一基线回放数据，冷/热缓存分开，报中位数与 p95，不用单次最佳值
- **不得**以静态重构冒充已取得性能收益

## B0-06 批次切片与进度

进度记录在 `docs/plans/2026-11-18-batch-progress.md`（每批结束更新）。

## M0 门槛核对

- [x] 基线已确认（HEAD/分支/版本/上游比较点）
- [x] 漂移已记录（55 提交，含一次上游合并）
- [x] 环境偏差已记录（Node 版本、CMake 前置）
- [x] 证据标签约定已建立
- [x] 已知证伪项已关闭（4 条）
- [x] 失效入口已识别（B1-05 `reviewQueue.ts`）
- [ ] 性能基线（未授权启动实例，标「未测」）
- [ ] 隔离夹具补齐（B4/B6 依赖项，随批次建立）
