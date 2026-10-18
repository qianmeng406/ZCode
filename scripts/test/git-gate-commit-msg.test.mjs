import assert from "node:assert/strict";
import test from "node:test";

import { formatValidationErrors, validateCommitMessage } from "../git-gate/commit-msg.mjs";

test("接受 Conventional Commits 标题（含 scope、感叹号与中文主题）", () => {
  for (const header of [
    "feat(git-gate): 按推送范围选择强相关测试",
    "fix: 修复进程树清理预算",
    "chore(deps)!: 升级依赖",
    "security(ci): 增加密钥扫描",
  ]) {
    const result = validateCommitMessage(`${header}\n\n正文说明。\n`);
    assert.equal(result.ok, true, header);
    assert.deepEqual(result.errors, []);
  }
});

test("放行 Git 与 rebase 生成的标题", () => {
  for (const header of [
    "Merge branch 'main' into feature",
    'Revert "feat: x"',
    "fixup! feat: x",
    "squash! fix: y",
    "amend! chore: z",
  ]) {
    assert.equal(validateCommitMessage(header).ok, true, header);
  }
});

test("拒绝空标题、未知 type、缺少冒号与超长标题", () => {
  assert.equal(validateCommitMessage("").ok, false);
  assert.equal(validateCommitMessage("# 只有注释\n").ok, false);
  assert.equal(validateCommitMessage("update stuff").ok, false);
  assert.equal(validateCommitMessage("feature: not a valid type").ok, false);
  assert.equal(validateCommitMessage("feat 缺少冒号").ok, false);
  assert.equal(validateCommitMessage(`feat: ${"x".repeat(120)}`).ok, false);
});

test("忽略注释行，取第一条有效标题", () => {
  const result = validateCommitMessage("# Please enter the commit message\n\nfeat(gate): ok\n");
  assert.equal(result.ok, true);
  assert.equal(result.header, "feat(gate): ok");
});

test("失败时给出可操作的提示", () => {
  const result = validateCommitMessage("nope");
  assert.equal(result.ok, false);
  const lines = formatValidationErrors(result);
  assert.ok(lines.length >= 3);
  assert.match(lines.join("\n"), /Conventional Commits/u);
  assert.match(lines.join("\n"), /feat\|fix\|docs/u);
});
