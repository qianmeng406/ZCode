#!/usr/bin/env node
/**
 * 预览强相关测试选择（不执行测试）。
 *
 *   node scripts/git-gate/preview.mjs --base <sha> [--head <sha>] [--scope strong|package|full]
 *   node scripts/git-gate/preview.mjs --base origin/main
 */

import {
  diffNumstatMap,
  normalizeRange,
  readChangedFiles,
  resolveChangeRange,
} from "./changed.mjs";
import { buildRepoIndex, listCandidateTests, selectRelatedTests } from "./relevance.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const cwd = process.cwd();
const range =
  normalizeRange({ cwd, base: option("--base"), head: option("--head") ?? "HEAD" }) ??
  resolveChangeRange({ cwd, stdin: process.env.ZCODE_PRE_PUSH_STDIN ?? "" });

if (!range) {
  console.error("[git-gate] 无法确定比较范围，请显式传 --base <sha>。");
  process.exitCode = 2;
} else {
  const { changed, deleted, comparisonBase } = await readChangedFiles(cwd, range);
  const stats = diffNumstatMap(cwd, comparisonBase, range.head);
  const additionsOnlySources = [...stats.entries()]
    .filter(([, value]) => value.deleted === 0)
    .map(([path]) => path);
  const index = buildRepoIndex(cwd);
  const candidates = listCandidateTests({ cwd, root: cwd });
  const result = selectRelatedTests({
    index,
    changedFiles: changed,
    deletedFiles: deleted,
    candidates,
    scope: option("--scope") ?? process.env.ZCODE_GATE_SCOPE ?? "strong",
    additionsOnlySources,
  });

  console.log(`[git-gate] 范围 ${range.label}：改动 ${changed.length}，删除 ${deleted.length}`);
  console.log(`[git-gate] 扫描测试文件 ${result.scanned}，选中 ${result.selected.length}`);
  for (const entry of result.hubSkipped) {
    console.log(
      `[git-gate] 枢纽文件跳过 import 归因：${entry.source}（${entry.importers} 个测试）`,
    );
  }
  for (const entry of result.hubExpanded) {
    console.log(
      `[git-gate] 枢纽文件含删除行，选中全部直接 import 测试：${entry.source}（${entry.importers} 个）`,
    );
  }
  for (const file of result.selected) console.log(`  + ${file}`);
  if (result.uncovered.length > 0) {
    console.log(`[git-gate] 未覆盖的改动源码 ${result.uncovered.length} 个：`);
    for (const file of result.uncovered) console.log(`  ? ${file}`);
  }
}
