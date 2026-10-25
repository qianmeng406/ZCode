# dev-loop：开发期「改动 → 验证 → 出包」的边界设计

dev-loop 与 git 提交门禁（`docs/git-gate.md`）同构：**同一份变更范围解析**驱动类型
检查选择、测试选择、出包决策；每一步可单独执行、可 `--dry-run`、报告"选了什么、
为什么、什么没覆盖"；**不盲目全量，全量永远显式触发**。dev-loop 不挂任何钩子，
不改变 pre-commit / pre-push / CI 的任何行为。

## 入口

| 命令               | 作用                                                  |
| ------------------ | ----------------------------------------------------- |
| `pnpm dev:check`   | 范围内的类型检查 + 强相关测试                         |
| `pnpm dev:package` | 范围相关的桌面出包（dist-preview-perf，增量优先）     |
| `pnpm dev:gate`    | 链式：检查通过后按影响判定自动出包（日常默认入口）    |
| `dev-gate.cmd`     | `dev:gate` 的 Windows 包装（对齐 gate-push.cmd 风格） |

公共参数：`--base <ref>`（显式范围，merge-base 语义）、`--dry-run`（只打印选择结果）。

`dev:check` 专属：`--tests-only`、`--typecheck-only`、`--direct`（类型检查只查改动包，
默认含反向依赖闭包）、`--scope strong|package|full`（测试范围，语义同门禁）。
`dev:package` 专属：`--full`（完整 electron-builder --dir）、`--force-build`、
`--dist <dir>`（默认 `dist-preview-perf`）。

## 范围解析（scripts/dev-loop/scope.mjs）

- 显式 `--base` 优先：`merge-base(base, HEAD)..HEAD`（与门禁推送范围同语义）；
- 默认 worktree 模式：`HEAD..工作区`（diff ACMRTUXB + D）+ 未跟踪文件
  （`ls-files --others --exclude-standard`，天然滤掉 gitignore）；
- 无法确定范围时 fail closed（退出码 2），不猜、不跑全量；
- 全局影响文件（`pnpm-lock.yaml`、`vitest.config.ts`、`tsconfig.base.json`、根
  `package.json` 等）只打印提示，**不自动升级全量**（与 git-gate fcee8b40 一致）；
  全量由 CI unit-full 或显式 `--scope full` 覆盖。

## 边界表

| 改动类型                                                 | 类型检查                                          | 测试                          | 出包                                              |
| -------------------------------------------------------- | ------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| 仅 `*.md` / `docs/`                                      | 跳过                                              | 跳过                          | 跳过                                              |
| 单包 `src/`                                              | 该包 + 反向依赖闭包（`tsc -b`，tsbuildinfo 增量） | strong 相关                   | 增量 asar                                         |
| 仅测试文件（含 e2e 用例）                                | 跳过                                              | 直接跑这些测试                | 跳过                                              |
| 共享包（shared/rpc/services）                            | 依赖闭包（近全图，tsbuildinfo 增量）              | strong 相关（枢纽不升级全量） | 增量 asar                                         |
| 全局配置文件                                             | 提示需显式全量，不自动跑                          | strong 相关                   | 按 src 判定                                       |
| desktop 资源层（config/scripts/resources 等 src 外文件） | —                                                 | —                             | **失败并要求 `--full`**（不静默产出不含改动的包） |
| `apps/zcode-cli`                                         | 提示走 `pnpm --dir apps/zcode-cli typecheck`      | CLI turbo（不在根链路）       | **失败并要求 `--full`**（agent bundle 层）        |
| `scripts/`（打包脚本除外）                               | 跳过                                              | scripts glob 内测试           | 跳过                                              |

## 类型检查边界（scripts/dev-loop/tsgraph.mjs）

- 启动时纯文本解析各包 `tsconfig.json` 的 `references` 建 `{项目 → 依赖, 被依赖}`
  图；收集范围 = 根 `pnpm typecheck` 的超集（含 desktop 的 main/host/e2e、
  shared/tsconfig.testing.json、apps/dev-docs）。
- **desktop 的 aggregate/scheduler/preload/renderer 不入裁决面**（`ROOT_TYPECHECK_
EXCLUDED_PROJECTS`）：根 typecheck 有意不覆盖它们，且这些工程在上游基线上本就
  存在类型报错（Window.zcode 全局声明、rootDir 越界）；dev:check 与根脚本对齐，
  不扩大裁决面。
- 执行 `tsc -b <项目...>`（composite + tsbuildinfo 天然增量），**跳过重型
  `typecheck:deps`**；`packages/zcode-cua` 与 `desktop/tsconfig.remote-main.json`
  沿用根脚本的 `tsc -p --noEmit` 形态。
- 受影响闭包内被其它入选项目引用的工程会被去重（`tsc -b` 传递构建它们）。

## 测试边界（复用 scripts/git-gate/relevance.mjs）

与 pre-push 门禁完全同一条强相关选择：改动测试 + 直接 import 改动源码的测试 +
同包同名测试，**刻意不做传递展开**（共享 barrel 会放大到近全仓）。vitest 按位置
参数分批 spawn；node:test 分流（packages/ 走 fork runner，scripts/ 走 `node --test`）。

全量单测入口 `pnpm test:unit` 支持过滤透传：`pnpm test:unit -- <文件或目录...>`；
不带参数行为与原全量完全一致。

## 出包边界（scripts/dev-loop/run-package.mjs）

内置 Preview 基线，消灭手拼环境变量：
`ZCODE_ENV=production`、`ZCODE_PREVIEW_IDENTITY=1`、
`ZCODE_DESKTOP_DIST_DIR=dist-preview-perf`、`--os win --arch x64`。

- **增量路径（默认）**：先做边界判定——改动含 desktop 资源层或 `apps/zcode-cli`
  （CLI agent bundle 经 prepare:runtime-assets 进入产物）时**直接失败并列出文件，
  要求 `--full`**（增量 asar 刷新不了这些层，静默成功会产出不含改动的包）；
  仅文档/测试/无关包改动时跳过（`dev:package` 独立运行也自行解析 worktree 范围
  做同一套判定，且要求 out/ 新鲜，过期则继续重建，覆盖 pull 后的场景）。
  通过后走 `out/.build-stamp` 新鲜度判定（dev:gate 链式时用「触及文件的 mtime >
  构建戳」精确判断；独立运行时早退遍历 watched src）→ 过期先
  `build:no-runtime-assets`，新鲜跳过 → `refreshPackagedAppAsar` 只重打 app.asar
  → 复用 bundle.mjs 的 `verifyPackagedRuntimeDependencies` 机械校验（依赖闭包 +
  native 越界）。
- **前置守卫**：外部 `ZCODE_ENV` 非 production 时告警并强制以 production 运行
  （Preview 基线；test 会打进测试渠道配置）；app.asar 不存在 → 提示先 `--full`；
  tasklist 检出 `ZCode Preview.exe` 运行中 → 提示先完全退出。
- **`--full`**：完整 electron-builder `--dir`（含 prepare + build），资源层与
  agent bundle 变更时必须走这条；`--force-build` 只强制重建 JS（不覆盖资源层）。
- 产物只能原路径启动验证（`dist-preview-perf/win-unpacked/ZCode Preview.exe`），
  **禁止复制到新目录**——未签名 exe 复制到新路径会被 Windows 拦截
  （exit 0x80000003），原路径实例已受信任。

## 已知边界

- desktop 的 renderer/preload/scheduler 不做类型检查（根 typecheck 同样不覆盖）；
  这层的错误由出包时的 vite 构建兜底。
- `apps/zcode-cli` 与 dsh 插件不在根 dev-loop 链路内（各自独立体系），只提示不执行。
- 不做文件级 typecheck（tsc 最小粒度是 tsconfig 项目）。
- 增量 asar 不刷新 `resources/` 下资源层；`packages/desktop` 下非 src/test 的改动
  一律判为资源层 → 建议 `--full`。
- 本地全量（`--scope full` / `pnpm test:unit` 不带过滤）耗时以分钟计；权威全量
  裁决在 CI（quality-gate.yml 的 unit-full）。
