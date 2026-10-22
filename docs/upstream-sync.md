# 官方上游同步基线与流程

本文件记录本定制版（fork）与官方 [zai-org/ZCode](https://github.com/zai-org/ZCode) 的**同步基线**和后续跟进流程。
机器可读版本见同目录 [upstream-sync.json](upstream-sync.json)。

## 1. 当前基线

| 项                  | 值                                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方上游仓库        | `https://github.com/zai-org/ZCode`（git remote 名为 `origin`，**只读 fetch，绝不 push**）                                                                                                                                                      |
| 本定制仓库          | `https://github.com/qianmeng406/ZCode`（git remote 名为 `zcodefork`，**唯一发布 push 目标**；定制主线分支 `main`）                                                                                                                             |
| 已废弃的旧线        | `https://github.com/qianmeng406/Myzcode`（remote `myzcode`，v3.14.3 基线）：2026-10-13 迁移完成后由本定制仓库取代，**不再作为合并对象、不再作为发布目标**（本地跟踪引用停在 `e5a9eb37`，此后无更新且匿名不可读）。不要把它的提交当作待对齐基线 |
| 当前上游基线 tag    | 无（3.16.2 未打 tag，以 `main` 提交发布）                                                                                                                                                                                                      |
| 当前上游基线 commit | `3c5b227649371507ddc4eb46ac5133afe6db1cab`（Source-Commit `5a082039a1a3b1edfe8364a33c8978689c0d68bf`）                                                                                                                                         |
| 定制引入方式        | 定制功能以**提交序列**套用在官方基线之上（源自旧仓库 `qianmeng406/Myzcode` 在 v3.14.3 基线上的定制 `72ac0508` 迁移，其后叠加后续功能提交）                                                                                                     |
| 桌面产品版本        | `3.16.2`（根 `package.json` 的 `version`）                                                                                                                                                                                                     |
| 独立 CLI 版本       | `0.17.0`（随上游，`apps/zcode-cli/package.json`）                                                                                                                                                                                              |

## 2. 后续跟进官方新版（保留定制）的流程

1. **拉取官方**（只读）：
   ```bash
   git fetch origin --tags
   ```
2. **确认目标 tag/commit**：选定要跟进的上游 tag，例如 `vX.Y.Z`，并记录其 commit SHA。
3. **开合并分支**（不要直接在 `main` 上操作）：
   ```bash
   git switch -c integrate/merge-upstream-vX.Y.Z main
   git merge --no-commit --no-ff <上游 commit 或 tag>
   ```
4. **解决冲突（保留定制语义）**：
   - 冲突面集中在定制功能涉及的文件（Oracle 审查、research/minimal 模式、提示词优化器、
     会话回合导航、远控资源随包分发 + SSH 常驻等）；
   - **不恢复已退役功能**：自建移动端远控（companion/mobile）、项目开发模式（workflow）、
     Command Code 渠道与网关额度、ACP 运行时与内置 Agent CLI（权威清单见
     [upstream-sync.json](upstream-sync.json) 的 `retiredFeatures`）；
   - 冲突解决后 `git add`，确认 `git diff --cached --check` 无冲突标记。
5. **全面验收**（真实日志、真实 exit code，不得用 typecheck 代替测试）：
   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm test:unit            # 多 runner 全量
   pnpm --dir apps/zcode-cli check
   ```
6. **提交合并**（保留真实祖先）：
   ```bash
   git commit
   git merge-base --is-ancestor <上游 tag> HEAD   # 必须成功；上游未打 tag 时改用上游 commit SHA 校验
   ```
7. **更新本文件与 `upstream-sync.json`**：把“当前基线”改为新的 tag/commit；`retiredFeatures` 有变化时一并更新。
8. **发布**（只推 `zcodefork`；定制主线是**远端 `zcodefork/main`**，不是官方 `origin/main`）：

   ```bash
   git fetch zcodefork
   git switch -c main --track zcodefork/main   # 本地 main 必须跟踪 zcodefork/main
   git merge --ff-only migrate/fork-features   # 定制分支先并入 main（保持 fast-forward）
   git push zcodefork main
   ```

   - 注意：本地没有 `main` 时不能裸跑 `git switch main`——那会新建一个跟踪**官方 `origin/main`** 的分支，等于把两条线搞反。
   - **绝不**向 `origin`（官方 zai-org/ZCode）push，**绝不**向已废弃的 `myzcode` push，
     **绝不** force，**绝不**重写已发布历史。

## 3. 职责边界提醒

- `origin`（官方）只用于 `fetch`，任何情况下不 push；发布只走 `zcodefork`。
- `myzcode`（旧线，已废弃）只用于读取历史，不 push、不合并、不作为基线。
- 本文件只记录**基线事实**；具体某项定制的取舍以仓库当前源码、测试与 README 为准。
