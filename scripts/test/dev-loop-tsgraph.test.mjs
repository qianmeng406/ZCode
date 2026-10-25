import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  affectedProjectIds,
  buildTsProjectGraph,
  changedDirsOfFiles,
  parseTsconfigReferences,
} from "../dev-loop/tsgraph.mjs";

function tsconfig(content) {
  return content;
}

function makeFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "zcode-dev-loop-tsgraph-"));
  const write = (relativePath, content) => {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  };

  write(
    "packages/shared/tsconfig.json",
    tsconfig(`{
    // composite 由 base 提供
    "extends": "../../tsconfig.base.json",
  }`),
  );
  write(
    "packages/shared/tsconfig.testing.json",
    tsconfig(`{
    "references": [{ "path": "." }]
  }`),
  );
  write("packages/rpc/tsconfig.json", tsconfig(`{ "extends": "../../tsconfig.base.json" }`));
  write(
    "packages/services/tsconfig.json",
    tsconfig(`{
    "references": [{ "path": "../shared" }, { "path": "../rpc" }]
  }`),
  );
  write(
    "packages/client/tsconfig.json",
    tsconfig(`{
    "references": [{ "path": "../services" }, { "path": "../rpc" }]
  }`),
  );
  write("packages/provider/tsconfig.json", tsconfig(`{ "extends": "../../tsconfig.base.json" }`));
  write(
    "packages/ui/tsconfig.json",
    tsconfig(`{
    "references": [
      { "path": "../provider" },
      { "path": "../shared" },
      { "path": "../services" },
      { "path": "../rpc" },
    ]
  }`),
  );
  write(
    "packages/web/tsconfig.json",
    tsconfig(`{
    "references": [{ "path": "../ui" }, { "path": "../client" }]
  }`),
  );
  write(
    "packages/desktop/tsconfig.json",
    tsconfig(`{
    "references": [
      { "path": "./tsconfig.main.json" },
      { "path": "./tsconfig.renderer.json" },
    ]
  }`),
  );
  write(
    "packages/desktop/tsconfig.main.json",
    tsconfig(`{
    "references": [{ "path": "../shared" }, { "path": "../services" }]
  }`),
  );
  write(
    "packages/desktop/tsconfig.renderer.json",
    tsconfig(`{
    "references": [{ "path": "../shared" }, { "path": "../ui" }, { "path": "../client" }]
  }`),
  );
  write(
    "packages/desktop/tsconfig.remote-main.json",
    tsconfig(`{
    "references": [{ "path": "../rpc" }, { "path": "../shared" }, { "path": "../client" }]
  }`),
  );
  write("packages/zcode-cua/tsconfig.json", tsconfig(`{ "extends": "../../tsconfig.base.json" }`));
  write("apps/dev-docs/tsconfig.json", tsconfig(`{ "extends": "../../tsconfig.base.json" }`));
  return root;
}

test("parseTsconfigReferences 容忍注释与尾逗号", () => {
  const refs = parseTsconfigReferences(
    tsconfig(`{
    // 行注释
    /* 块注释 */
    "references": [{ "path": "../shared" }, { "path": "../rpc" },],
  }`),
  );
  assert.deepEqual(refs, ["../shared", "../rpc"]);
  assert.deepEqual(parseTsconfigReferences(`{ "compilerOptions": {} }`), []);
});

test("buildTsProjectGraph：项目发现、kind 与边", () => {
  const root = makeFixtureRepo();
  try {
    const graph = buildTsProjectGraph(root);
    const ui = graph.get("packages/ui/tsconfig.json");
    assert.ok(ui);
    assert.equal(ui.kind, "b");
    assert.deepEqual(ui.refs, [
      "packages/provider/tsconfig.json",
      "packages/rpc/tsconfig.json",
      "packages/services/tsconfig.json",
      "packages/shared/tsconfig.json",
    ]);
    assert.equal(graph.get("packages/zcode-cua/tsconfig.json").kind, "p");
    assert.equal(graph.get("packages/desktop/tsconfig.remote-main.json").kind, "p");
    const aggregate = graph.get("packages/desktop/tsconfig.json");
    assert.deepEqual(aggregate.refs, [
      "packages/desktop/tsconfig.main.json",
      "packages/desktop/tsconfig.renderer.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("affectedProjectIds（affected）：ui 改动收敛到聚合与 web，被覆盖者去重", () => {
  const root = makeFixtureRepo();
  try {
    const graph = buildTsProjectGraph(root);
    const ids = affectedProjectIds(graph, new Set(["packages/ui"]));
    // ui 的反向闭包 = ui、web、desktop 聚合、desktop.renderer；web（tsc -b 传递
    // 构建 ui）与聚合（覆盖 renderer/main）都足以覆盖被依赖者 → 去重后只剩两者。
    assert.deepEqual(ids, ["packages/desktop/tsconfig.json", "packages/web/tsconfig.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("affectedProjectIds（direct）：只查改动包拥有的项目", () => {
  const root = makeFixtureRepo();
  try {
    const graph = buildTsProjectGraph(root);
    const ids = affectedProjectIds(graph, new Set(["packages/desktop"]), { scope: "direct" });
    assert.deepEqual(ids, [
      "packages/desktop/tsconfig.json",
      "packages/desktop/tsconfig.main.json",
      "packages/desktop/tsconfig.remote-main.json",
      "packages/desktop/tsconfig.renderer.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("affectedProjectIds（affected）：shared 改动得到近全图（诚实的闭包）", () => {
  const root = makeFixtureRepo();
  try {
    const graph = buildTsProjectGraph(root);
    const ids = affectedProjectIds(graph, new Set(["packages/shared"]));
    // 闭包 = shared 及所有依赖它的项目；testing.json 引用 "." 覆盖 shared 主工程，
    // desktop 聚合覆盖其子工程，services/ui/client 被 web 覆盖（tsc -b 传递构建）
    // → 去重后只保留聚合、testing、web、p 模式 remote-main。
    assert.deepEqual(ids, [
      "packages/desktop/tsconfig.json",
      "packages/desktop/tsconfig.remote-main.json",
      "packages/shared/tsconfig.testing.json",
      "packages/web/tsconfig.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildTsProjectGraph：exclude 剔除根 typecheck 不覆盖的工程（对齐裁决面）", () => {
  const root = makeFixtureRepo();
  try {
    const graph = buildTsProjectGraph(root, {
      exclude: new Set([
        "packages/desktop/tsconfig.json",
        "packages/desktop/tsconfig.renderer.json",
      ]),
    });
    assert.equal(graph.has("packages/desktop/tsconfig.json"), false);
    const ids = affectedProjectIds(graph, new Set(["packages/desktop"]));
    assert.deepEqual(ids, [
      "packages/desktop/tsconfig.main.json",
      "packages/desktop/tsconfig.remote-main.json",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changedDirsOfFiles 忽略无法归属的文件", () => {
  const dirs = changedDirsOfFiles([
    "packages/ui/src/a.ts",
    "apps/dev-docs/test/b.ts",
    "package.json",
  ]);
  assert.deepEqual([...dirs].sort(), ["apps/dev-docs", "packages/ui"]);
});
