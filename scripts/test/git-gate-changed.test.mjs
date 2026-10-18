import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  diffNumstatMap,
  hasCommit,
  normalizeRange,
  readChangedFiles,
  readFileAtRevision,
} from "../git-gate/changed.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gate-test",
      GIT_AUTHOR_EMAIL: "gate-test@example.invalid",
      GIT_COMMITTER_NAME: "gate-test",
      GIT_COMMITTER_EMAIL: "gate-test@example.invalid",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "git-gate-changed-"));
  git(root, ["init", "-q"]);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "chore: base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(root, "src", "c.ts"), "export const c = 1;\n");
  git(root, ["rm", "-q", "src/b.ts"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "chore: change"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

test("hasCommit 与 normalizeRange 拒绝不存在的 sha", () => {
  const { root, base, head } = makeRepo();
  try {
    assert.equal(hasCommit(root, base), true);
    assert.equal(hasCommit(root, "0".repeat(40)), false);
    const range = normalizeRange({ cwd: root, base, head });
    assert.equal(range.base, base);
    assert.equal(range.head, head);
    assert.throws(() => normalizeRange({ cwd: root, base: "f".repeat(40) }), /base 不存在/u);
    assert.equal(normalizeRange({ cwd: root }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readChangedFiles 区分新增/修改与删除，diffNumstatMap 给出增删行数", async () => {
  const { root, base, head } = makeRepo();
  try {
    const { changed, deleted, comparisonBase } = await readChangedFiles(root, {
      base,
      head,
      label: "test",
      useMergeBase: false,
    });
    assert.equal(comparisonBase, base);
    assert.deepEqual([...changed].sort(), ["a.ts", "src/c.ts"]);
    assert.deepEqual([...deleted].sort(), ["src/b.ts"]);

    const stats = diffNumstatMap(root, base, head);
    assert.deepEqual(stats.get("a.ts"), { added: 1, deleted: 1 });
    assert.deepEqual(stats.get("src/c.ts"), { added: 1, deleted: 0 });
    assert.deepEqual(stats.get("src/b.ts"), { added: 0, deleted: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFileAtRevision 读取指定版本内容，缺失返回 undefined", () => {
  const { root, base, head } = makeRepo();
  try {
    assert.match(readFileAtRevision(root, head, "a.ts"), /a = 2/u);
    assert.match(readFileAtRevision(root, base, "a.ts"), /a = 1/u);
    assert.equal(readFileAtRevision(root, base, "src/c.ts"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
