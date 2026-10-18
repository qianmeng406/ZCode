# Pre-push Hook

仓库通过 Husky 接管 Git 的 `pre-commit` / `commit-msg` / `pre-push`。完整的分层设计与 CI 配置见 [Git 门禁](../git-gate.md)。

- 安装依赖后会执行根脚本 `pnpm prepare`，自动完成 Husky 安装。
- `pre-commit`：只检查暂存文件——文件策略与密钥初筛、`oxlint`、`oxfmt --check`。
- `commit-msg`：校验 Conventional Commits 标题；`Merge` / `Revert` / `fixup!` / `squash!` 放行。
- `pre-push`：执行 `pnpm run verify:pre-push`，即 `scripts/git-gate/run-pre-push.mjs`。

`pre-push` 的检查顺序与范围：

1. **文件策略**：本次推送范围的禁止路径与高置信密钥初筛。
2. **改动文件 lint/fmt**：只对变更文件跑 `oxlint` 与 `oxfmt --check`。
3. **架构检查**：`architecture:check --changed`。
4. **强相关单测**：改动到的测试 + 直接 import 改动源码的测试 + 同 package 同名测试；不再使用 `vitest related` 的传递闭包，也不跑全量。
5. 全局配置或依赖段变化、枢纽文件删除导出时，自动升级为全量并打印原因。

默认比较范围按以下顺序确定：

- 显式 `ZCODE_GATE_BASE`（兼容旧的 `ZCODE_PRE_PUSH_BASE` / `ZCODE_AFFECTED_TEST_BASE`）与 `HEAD` 的 merge-base；
- Git `pre-push` stdin 的 `remote_sha..local_sha`；
- 当前分支的 `@{upstream}..HEAD`；
- 默认分支（`origin/HEAD`、`origin/main` 等）的 merge-base。

无法确定范围时门禁直接失败并提示显式传 base，不会静默跑全量。

通过结果按「推送范围 + scope + 工具链」缓存，重试推送不会重复检查：

```bash
ZCODE_PREPUSH_NO_CACHE=1 git push   # 强制重跑
rm -rf .git/zcode-prepush-cache     # 清空缓存
ZCODE_GATE_SCOPE=package git push   # 放大到同 package 全部测试
ZCODE_GATE_SCOPE=full git push      # 全量单测
```

## 开发环境与版本管理工具

钩子直接使用当前 `PATH` 中的 pnpm / Node，不强制依赖 mise。

```text
开发者准备 Node / pnpm（mise、nvm 或其他方式）
    → Git hook 保留 push ref 信息并清理 Git local env
    → node scripts/git-gate/run-pre-push.mjs
    → 文件策略 / 改动文件 lint+fmt / 架构 / 强相关单测
```

- 仓库负责声明工具版本和执行检查；个人环境负责让合适的 Node / pnpm 可被 Git 找到。
- GUI Git 客户端若找不到 Node / pnpm，可在个人 `~/.config/husky/init.sh` 中初始化自己的版本管理环境，参见 [Husky 官方说明](https://typicode.github.io/husky/how-to.html#node-version-managers-and-guis)。
- 缺少命令或检查失败仍然阻止 push；hook 不自动安装工具，不静默跳过检查。

## 范围边界

该入口覆盖根 Vitest 单测与 fork `node:test`，不替代 `apps/zcode-cli` 自身的 Turbo/Vitest 测试，也不替代桌面端 E2E。全量单测入口为 `pnpm test:unit`，CI 中每周与手动触发。
