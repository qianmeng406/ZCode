import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_CONSUMED_PACKAGES,
  classifyDesktopImpact,
  isDocPath,
  isTestPath,
  isWatchedSrcPath,
  packageDirOf,
  parseNumstatAdditionsOnly,
} from "../dev-loop/scope.mjs";

test("isDocPath / packageDirOf 的分类口径", () => {
  assert.equal(isDocPath("docs/git-gate.md"), true);
  assert.equal(isDocPath("README.md"), true);
  assert.equal(isDocPath("packages/ui/src/store/index.ts"), false);
  assert.equal(packageDirOf("packages/ui/src/store/index.ts"), "packages/ui");
  assert.equal(packageDirOf("apps/dev-docs/test/x.ts"), "apps/dev-docs");
  assert.equal(packageDirOf("package.json"), undefined);
});

test("classifyDesktopImpact：仅文档/测试改动不出包", () => {
  const impact = classifyDesktopImpact([
    "docs/dev-loop.md",
    "packages/ui/test/v4SessionDataLayer.test.ts",
  ]);
  assert.equal(impact.mode, "none");
});

test("classifyDesktopImpact：消费包 src 改动 → 增量出包", () => {
  const impact = classifyDesktopImpact([
    "packages/ui/src/v4/ConversationTimeline.tsx",
    "packages/shared/src/util.ts",
    "packages/ui/test/v4SessionDataLayer.test.ts",
  ]);
  assert.equal(impact.mode, "incremental");
  assert.equal(impact.incremental.length, 2);
  assert.ok(DESKTOP_CONSUMED_PACKAGES.has("packages/ui"));
});

test("classifyDesktopImpact：资源层与 CLI agent bundle → 完整打包", () => {
  const impact = classifyDesktopImpact([
    "packages/desktop/config/provider/zcode-builtin.json",
    "apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts",
  ]);
  assert.equal(impact.mode, "full");
  // CLI 文件单列在 cli（同属 --full 理由，但不混入资源层清单）
  assert.equal(impact.full.length, 1);
  assert.equal(impact.cli.length, 1);
});

test("classifyDesktopImpact：desktop 下的 src 与非 src 分流", () => {
  const impact = classifyDesktopImpact([
    "packages/desktop/src/main/desktopProviderConfig.ts",
    "packages/desktop/scripts/prepare-runtime-assets.mjs",
  ]);
  assert.equal(impact.mode, "full");
  assert.deepEqual(impact.incremental, ["packages/desktop/src/main/desktopProviderConfig.ts"]);
});

test("classifyDesktopImpact：仅 CLI agent 源码改动同样要求完整打包", () => {
  const impact = classifyDesktopImpact([
    "apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts",
  ]);
  // CLI agent bundle 经 prepare:runtime-assets 进入桌面产物，只有 --full 刷新，
  // 不能被归为 none（否则 dev:gate 会以错误理由跳过出包）。
  assert.equal(impact.mode, "full");
  assert.equal(impact.cli.length, 1);
  assert.deepEqual(impact.full, []);
});

test("classifyDesktopImpact：e2e 用例属于测试文件，不出包", () => {
  const impact = classifyDesktopImpact([
    "packages/desktop/test/e2e/conversation-session-verified.test.ts",
  ]);
  assert.equal(impact.mode, "none");
});

test("parseNumstatAdditionsOnly 与 gate 语义一致：仅 deleted === 0 才算只新增行", () => {
  const stdout = [
    "5\t0\tonly-adds.ts",
    "5\t3\tadds-and-dels.ts",
    "-\t-\tbinary.png",
    "0\t2\tonly-dels.ts",
    "",
  ].join("\n");
  // binary 行的 "-" 映射为 0（与 gate 的 diffNumstatMap 相同）；既增又删的文件
  // 必须不算只新增——否则其直接 import 的测试会被错误跳过归因。
  assert.deepEqual(parseNumstatAdditionsOnly(stdout), ["only-adds.ts", "binary.png"]);
});

test("classifyDesktopImpact：与桌面产物无关的包不出包", () => {
  const impact = classifyDesktopImpact([
    "packages/server/src/listen.ts",
    "packages/web/src/App.tsx",
    "packages/model-option-map/test/x.test.ts",
  ]);
  assert.equal(impact.mode, "none");
});

test("isTestPath（转引自 relevance）与 watched src 的边界", () => {
  assert.equal(isTestPath("packages/ui/test/a.test.ts"), true);
  assert.equal(isTestPath("packages/ui/src/a.ts"), false);
  assert.equal(isWatchedSrcPath("packages/ui/src/a.ts"), true);
  assert.equal(isWatchedSrcPath("packages/ui/test/a.test.ts"), false);
  assert.equal(isWatchedSrcPath("packages/server/src/a.ts"), false);
});
