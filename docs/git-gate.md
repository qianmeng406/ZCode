# Git 门禁

本仓库的门禁分四层：**本地钩子做快速反馈，GitHub Actions 做权威裁决，Rulesets 负责强制**。任何一层都不运行「全量测试换安心」——全量单测只保留手动/定时入口。

| 层                 | 触发                           | 检查内容                                                                              | 目标耗时 |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------- | -------- |
| `pre-commit`       | 每次提交                       | 暂存文件的文件策略与密钥初筛、`oxlint`、`oxfmt --check`                               | 秒级     |
| `commit-msg`       | 每次提交                       | Conventional Commits 标题格式                                                         | 瞬时     |
| `pre-push`         | 每次推送                       | 推送范围的文件策略、改动文件 lint/fmt、`architecture:check --changed`、**强相关单测** | 分钟级   |
| `quality-gate.yml` | PR / push `main` / 每周 / 手动 | 全量 lint、architecture、typecheck、密钥扫描、强相关单测；全量单测仅手动/定时         | 视范围   |

## 本地命令

```bash
pnpm gate:pre-commit          # 等价于 pre-commit 钩子
pnpm gate:commit-msg <file>   # 校验单条提交信息
pnpm gate:tests               # 只跑强相关单测（pre-push 的测试段）
pnpm test:unit:affected       # 兼容别名，等同 gate:tests
pnpm verify:pre-push          # 完整本地门禁
pnpm test:unit                # 全量单测（手动/CI）
```

`pre-push` 内置「同一推送范围 + 同一 scope + 同一工具链」的通过结果缓存：

```bash
ZCODE_PREPUSH_NO_CACHE=1 git push   # 强制重跑
rm -rf .git/zcode-prepush-cache     # 清空缓存
```

缓存只记录通过结果；失败、工作区有未提交改动、无法确定推送范围时一律照跑。

## 强相关测试怎么选

`scripts/git-gate/relevance.mjs` 取以下三者的并集，**不做传递展开**：

1. **改动集里的测试文件**——直接运行；
2. **直接 import 改动源码的测试**——解析 `import` / `export ... from` / `require` / 动态 `import` 的说明符，支持相对路径、`@/`、`@desktop/`、`@web/`、`@zcode/*`（含 exports 子路径与通配）、Node `#src/*`，以及 `.js` → `.ts` 的 nodenext 写法；
3. **同 package 同名/近同名测试**——把 camelCase / kebab-case / snake_case 归一成词序列后比较，覆盖 `appLaunchCoordinator.ts` ↔ `app-launch-coordinator.test.ts`、`x.ts` ↔ `x.v4.test.ts`。

`vitest related` 的传递闭包被刻意移除：共享 barrel（如 `packages/shared/src/index.ts`）被几百个测试直接 import，按「谁引用过」展开会退化回全量。

### 枢纽文件

被超过 **100** 个测试直接 import 的文件视为枢纽文件：

- 变更**只新增行** → 跳过它的 import 归因（真正的改动在它 re-export 的目标模块里，那些模块的 import 者仍会被选中），报告中列出被跳过的文件与测试数；
- 变更**含删除行** → 把这个枢纽文件的全部直接 import 测试加入选择集（删除导出可能让这些测试断裂）。数量有上界，仍远小于全量；不会自动升级全量。

### 全局影响文件

`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`vitest.config.ts`、`vitest.setup.ts`、`tsconfig.base.json`，以及 `package.json` 的依赖段（`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` / overrides）发生变化时：

- 本地 pre-push **只打印提示，仍跑强相关测试**，不会把一次依赖/配置改动拖成十几分钟的全量；
- 全量回归由 CI 的 `unit-full`（手动 / 每周）承担；需要本地强跑时显式使用 `ZCODE_GATE_SCOPE=full`。

### 显式放大范围

```bash
ZCODE_GATE_SCOPE=package git push   # 改动文件所属 package 的全部测试
ZCODE_GATE_SCOPE=full git push      # 全量单测
```

也可以手动指定比较范围：

```bash
ZCODE_GATE_BASE=origin/main pnpm gate:tests
pnpm gate:tests --base <sha> --head <sha>
pnpm gate:tests --base <sha> --dry-run   # 只打印选择结果
```

### 已知边界

- **未覆盖源码会逐条列出**。经中间模块间接引用改动源码的测试不在选择集内；需要更强覆盖时用 `ZCODE_GATE_SCOPE=package|full`，或依赖每周的全量任务。
- 根门禁只覆盖根 Vitest 范围与 fork `node:test`，不覆盖 `apps/zcode-cli` 的 Turbo 测试与桌面 E2E；CLI 改动请按 `apps/zcode-cli/AGENTS.md` 单独跑 CLI 测试。
- 候选测试来自 `git ls-files`，未跟踪的新测试文件不参与选择；先把测试加入版本库。
- `pnpm fmt:check` 在 vendored `docs/electron` 等目录存在存量漂移，因此本地/CI 的格式检查只针对改动文件；修复 vendored 文档后可以把 CI 的 `fmt:check` 提升为全量必需检查。

## 密钥与文件策略

本地是**高置信初筛**，零依赖：

- 禁止路径：`.env*`（放行 `.env.example` / `.env.template` / `.env.sample`）、`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.keystore` / `*.jks`、`id_rsa*` 等 SSH 私钥、`node_modules/`、`dist-release/`；
- 内容模式：PEM 私钥块、GitHub token/PAT、AWS access key、Slack token、Anthropic/OpenAI key、npm `_authToken`；
- 带 `example` / `sample` / `dummy` / `fake` / `placeholder` / `redacted` 标记的行视为示例值；
- `test/`、`tests/`、`fixtures/`、`__fixtures__/` 目录与 `*.test.*` / `*.spec.*` 文件跳过**内容**扫描（测试会故意存放假密钥），路径规则仍然生效。

权威扫描在 CI：`gitleaks-action` 扫描推送/PR 的提交历史。本地初筛不替代它。

## CI 与分支保护

`quality-gate.yml` 的作业：

| 作业                                                              | 运行环境       | 是否建议设为必需检查   |
| ----------------------------------------------------------------- | -------------- | ---------------------- |
| `Repository Policy`（文件策略 + 提交信息 + gitleaks）             | ubuntu         | 是                     |
| `Static Checks`（lint / architecture / typecheck / 改动文件检查） | ubuntu         | 是                     |
| `Strongly Related Tests`                                          | windows-latest | 是                     |
| `Full Unit Suite`（手动或每周一 03:00）                           | windows-latest | 暂否：全量基线尚未清零 |

Actions 均固定到完整 commit SHA，`permissions` 默认为 `contents: read`。

### 配置 Rulesets（需仓库管理员手动完成）

1. 打开 `Settings → Rules → Rulesets → New branch ruleset`，目标分支 `main`。
2. 启用 `Require a pull request before merging`。
3. 启用 `Require status checks to pass`，勾选 `Repository Policy`、`Static Checks`、`Strongly Related Tests`。
4. 启用 `Block force pushes` 与 `Restrict deletions`。
5. 保存后用一个故意不合规的 PR 验证：错误提交信息、`.env` 文件、失败测试都应被拦截。

只有工作流文件而没有必需检查配置，`main` 仍可被直接推送绕过——这一步必须实际开启。

## 豁免

紧急修复的豁免记录在 [gate-exceptions.md](gate-exceptions.md)，包含规则、PR、提交 SHA、范围、批准人与失效时间。本地不提供静默跳过开关（`ZCODE_PREPUSH_NO_CACHE=1` 只是强制重跑，不是豁免）；真正的绕过只能来自仓库管理员在 Rulesets 中按流程操作。
