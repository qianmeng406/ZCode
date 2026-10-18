import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildRepoIndex,
  canonicalStem,
  comparablePaths,
  extractImportSpecifiers,
  isCodeSourcePath,
  isTestPath,
  packageRootOf,
  resolveSpecifier,
  selectRelatedTests,
  stemWords,
  stemsRelated,
} from "../git-gate/relevance.mjs";

function writeFile(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "git-gate-relevance-"));
  writeFile(
    root,
    "packages/shared/package.json",
    JSON.stringify({
      name: "@zcode/shared",
      exports: {
        ".": "./src/index.ts",
        "./zcode-protocol-v4": "./src/zcode-protocol-v4/index.ts",
        "./remote/*.js": "./src/remote/*.ts",
      },
    }),
  );
  writeFile(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  writeFile(root, "packages/shared/src/zcode-protocol-v4/index.ts", "export const v4 = 1;\n");
  writeFile(root, "packages/shared/src/remote/connect.ts", "export const connect = 1;\n");
  writeFile(
    root,
    "packages/services/package.json",
    JSON.stringify({
      name: "@zcode/services",
      exports: { ".": "./src/index.ts", "./node": "./src/node.ts" },
      imports: { "#src/*": "./src/*" },
    }),
  );
  writeFile(root, "packages/services/src/index.ts", "export const services = 1;\n");
  writeFile(root, "packages/services/src/node.ts", "export const node = 1;\n");
  writeFile(root, "packages/services/src/foo.ts", "export const foo = 1;\n");
  writeFile(root, "packages/services/src/hub.ts", "export const hub = 1;\n");
  writeFile(
    root,
    "packages/ui/package.json",
    JSON.stringify({ name: "@zcode/ui", exports: { ".": "./src/index.ts" } }),
  );
  writeFile(root, "packages/ui/src/index.ts", "export const ui = 1;\n");
  writeFile(root, "packages/ui/src/lib/alert-dialog-store.ts", "export const store = 1;\n");
  writeFile(root, "packages/ui/src/root/account-panel.ts", "export const panel = 1;\n");
  return root;
}

function candidate(path, content = "") {
  return {
    path,
    content,
    runner: content.includes('from "node:test"') ? "node" : "vitest",
  };
}

test("文件名归一化覆盖 camelCase / kebab-case / 变体后缀", () => {
  assert.deepEqual(stemWords("appLaunchCoordinator.ts"), ["app", "launch", "coordinator"]);
  assert.deepEqual(stemWords("app-launch-coordinator.test.ts"), ["app", "launch", "coordinator"]);
  assert.equal(
    canonicalStem("appLaunchCoordinator.ts"),
    canonicalStem("app-launch-coordinator.test.ts"),
  );
  assert.equal(
    stemsRelated(
      canonicalStem("zcodeAgentService.ts"),
      canonicalStem("zcodeAgentService.v4.test.ts"),
    ),
    true,
  );
  assert.equal(stemsRelated(canonicalStem("foo.ts"), canonicalStem("foo.test.ts")), true);
  assert.equal(stemsRelated(canonicalStem("foo.ts"), canonicalStem("bar.test.ts")), false);
  assert.equal(stemsRelated("short", "shortcut"), false, "过短的文件名不做前后缀匹配");
});

test("测试/源码路径分类排除 E2E、d.ts 与测试文件", () => {
  assert.equal(isTestPath("packages/services/test/foo.test.ts"), true);
  assert.equal(isTestPath("packages/desktop/test/e2e/foo.test.ts"), false);
  assert.equal(isCodeSourcePath("packages/services/src/foo.ts"), true);
  assert.equal(isCodeSourcePath("packages/services/src/foo.test.ts"), false);
  assert.equal(isCodeSourcePath("packages/services/src/foo.d.ts"), false);
  assert.equal(packageRootOf("packages/services/test/foo.test.ts"), "packages/services");
});

test("import 提取覆盖静态/type/export-from/require/动态 import", () => {
  const specifiers = extractImportSpecifiers(`
    import a from "./a.js";
    import type { B } from "./b.js";
    import "./side-effect.js";
    export * from "./c.js";
    export { d } from "./d.js";
    const e = require("./e.js");
    const f = await import("./f.js");
  `);
  assert.deepEqual(
    [...specifiers].sort(),
    ["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "./side-effect.js"].sort(),
  );
});

test("解析相对路径、别名、workspace exports、子路径通配与 #imports", () => {
  const root = makeFixture();
  try {
    const index = buildRepoIndex(root);
    const resolve = (from, specifier) => resolveSpecifier(index, from, specifier);

    assert.equal(
      resolve("packages/services/test/foo.test.ts", "../src/foo.js"),
      "packages/services/src/foo.js",
      "解析保留 import 写法，扩展名替换交给 comparablePaths",
    );
    assert.deepEqual(
      [...comparablePaths("packages/services/src/foo")],
      [
        "packages/services/src/foo",
        "packages/services/src/foo.ts",
        "packages/services/src/foo.tsx",
        "packages/services/src/foo/index.ts",
        "packages/services/src/foo/index.tsx",
      ],
    );
    assert.ok(comparablePaths("packages/services/src/foo.js").has("packages/services/src/foo.ts"));

    assert.equal(
      resolve("packages/ui/test/x.test.ts", "@/lib/alert-dialog-store.js"),
      "packages/ui/src/lib/alert-dialog-store.js",
    );
    assert.equal(
      resolve("packages/services/test/x.test.ts", "@zcode/shared"),
      "packages/shared/src/index.ts",
    );
    assert.equal(
      resolve("packages/services/test/x.test.ts", "@zcode/shared/zcode-protocol-v4"),
      "packages/shared/src/zcode-protocol-v4/index.ts",
    );
    assert.equal(
      resolve("packages/services/test/x.test.ts", "@zcode/shared/remote/connect.js"),
      "packages/shared/src/remote/connect.ts",
    );
    assert.equal(
      resolve("packages/services/test/x.test.ts", "@zcode/services/node"),
      "packages/services/src/node.ts",
    );
    assert.equal(
      resolve("packages/services/test/x.test.ts", "#src/foo.js"),
      "packages/services/src/foo.js",
    );
    assert.equal(resolve("packages/services/test/x.test.ts", "unknown-package"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("选择器包含改动测试、直接 import、#imports 与同名测试，并报告未覆盖源码", () => {
  const root = makeFixture();
  try {
    const index = buildRepoIndex(root);
    const candidates = [
      candidate("packages/services/test/foo.test.ts", 'import { foo } from "../src/foo.js";'),
      candidate("packages/services/test/hash.test.ts", 'import { foo } from "#src/foo.js";'),
      candidate(
        "packages/services/test/node.test.ts",
        'import test from "node:test";\nimport x from "../src/foo.js";',
      ),
      candidate("packages/ui/test/alertDialogStore.test.ts"),
      candidate("packages/services/test/deleted.test.ts", 'import { old } from "../src/old.js";'),
      candidate("packages/services/test/unrelated.test.ts", 'import { x } from "@zcode/shared";'),
    ];
    const result = selectRelatedTests({
      index,
      changedFiles: ["packages/services/src/foo.ts", "packages/ui/src/lib/alert-dialog-store.ts"],
      deletedFiles: ["packages/services/src/old.ts"],
      candidates,
    });

    assert.equal(result.full, false);
    assert.deepEqual(result.selected, [
      "packages/services/test/deleted.test.ts",
      "packages/services/test/foo.test.ts",
      "packages/services/test/hash.test.ts",
      "packages/services/test/node.test.ts",
      "packages/ui/test/alertDialogStore.test.ts",
    ]);
    assert.deepEqual(result.node, ["packages/services/test/node.test.ts"]);
    assert.deepEqual(result.uncovered, [], "删除的文件不进入未覆盖统计");
    assert.ok(
      result.selected.includes("packages/services/test/deleted.test.ts"),
      "删除源码时，import 它的测试仍会被选中（暴露导入断裂）",
    );

    const withChangedTest = selectRelatedTests({
      index,
      changedFiles: ["packages/services/test/unrelated.test.ts", "packages/services/src/foo.ts"],
      candidates,
    });
    assert.ok(
      withChangedTest.selected.includes("packages/services/test/unrelated.test.ts"),
      "改动测试始终直接运行",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("枢纽文件只新增行时跳过 import 归因，含删除行时选中全部直接 import 测试", () => {
  const root = makeFixture();
  try {
    const index = buildRepoIndex(root);
    const candidates = [
      candidate("packages/services/test/a.test.ts", 'import { hub } from "../src/hub.js";'),
      candidate("packages/services/test/b.test.ts", 'import { hub } from "../src/hub.js";'),
      candidate("packages/services/test/c.test.ts", 'import { hub } from "../src/hub.js";'),
    ];
    const skipped = selectRelatedTests({
      index,
      changedFiles: ["packages/services/src/hub.ts"],
      candidates,
      hubThreshold: 2,
      additionsOnlySources: ["packages/services/src/hub.ts"],
    });
    assert.equal(skipped.full, false);
    assert.deepEqual(skipped.selected, []);
    assert.deepEqual(skipped.hubSkipped, [
      { source: "packages/services/src/hub.ts", importers: 3 },
    ]);

    const expanded = selectRelatedTests({
      index,
      changedFiles: ["packages/services/src/hub.ts"],
      candidates,
      hubThreshold: 2,
    });
    assert.equal(expanded.full, false);
    assert.equal(expanded.hubExpanded[0].importers, 3);
    assert.deepEqual(expanded.selected, candidates.map((entry) => entry.path).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope=package 会补上改动文件所属 package 的全部测试", () => {
  const root = makeFixture();
  try {
    const index = buildRepoIndex(root);
    const candidates = [
      candidate("packages/services/test/foo.test.ts", 'import { foo } from "../src/foo.js";'),
      candidate("packages/services/test/unrelated.test.ts"),
      candidate("packages/ui/test/unrelated.test.ts"),
    ];
    const result = selectRelatedTests({
      index,
      changedFiles: ["packages/services/src/foo.ts"],
      candidates,
      scope: "package",
    });
    assert.deepEqual(result.selected, [
      "packages/services/test/foo.test.ts",
      "packages/services/test/unrelated.test.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
