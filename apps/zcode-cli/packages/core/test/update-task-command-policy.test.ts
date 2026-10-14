import assert from "node:assert/strict";
import test from "node:test";
import { resolveUpdateTaskCommandDecision } from "../src/tool/handlers/bash-update-task-policy.js";
import { PermissionService } from "../src/permission/service.js";

/**
 * 旧极简自动权限的命令级执行边界：
 * 破坏性/写远端确认由 Bash AST 判定强制，不是提示词纪律。
 * 命令只作为字符串参与判定，测试绝不真正执行任何 git/shell 命令。
 * zcodeUpdate 模式连同其 merge/push 硬 deny 禁令已移除。
 */

test("merge/push family asks instead of auto-allowing", () => {
  for (const command of [
    "git push origin HEAD",
    "git pull",
    "git merge origin/main",
    "git cherry-pick abc123",
    "git rebase origin/main",
  ]) {
    assert.equal(resolveUpdateTaskCommandDecision({ command }), "ask", `${command} 必须单次确认`);
  }
});

test("forbidden git inside compound commands still asks", () => {
  assert.equal(
    resolveUpdateTaskCommandDecision({ command: "echo ok && git push origin HEAD" }),
    "ask",
  );
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git status; git pull" }), "ask");
  // 全局选项不放宽：git -C 换目录照样命中子命令。
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git -C /other/remote push" }), "ask");
});

test("destructive git operations ask instead of auto-allowing", () => {
  for (const command of [
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- src/app.ts",
    "git restore --staged .",
    "git rm -r src",
    "git stash drop",
    "git branch -D feature",
    "git tag -d v1",
    "git worktree remove ../wt",
  ]) {
    assert.equal(resolveUpdateTaskCommandDecision({ command }), "ask", `${command} 必须单次确认`);
  }
});

test("fetch asks (it is not read-only) while inspection commands allow", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git fetch origin --tags" }), "ask");
  for (const command of [
    "git status",
    "git log --oneline -5",
    "git diff v1..v2 --stat",
    "git ls-remote --tags origin",
    "pnpm typecheck",
    "rg -n TODO src",
  ]) {
    assert.equal(resolveUpdateTaskCommandDecision({ command }), "allow", command);
  }
});

test("plain stash and commit never auto-run (boundary: no auto stash/commit)", () => {
  // 审查发现的缺口回归：plain stash / commit 曾不在任何名单里、在自动放行分支下直接 allow，
  // 而批准边界是「不自动 stash、清理、合并、提交或推送」。
  for (const command of [
    "git stash",
    "git stash push -u",
    "git stash pop",
    "git stash apply",
    "git commit -m wip",
    "git commit --amend",
  ]) {
    assert.equal(
      resolveUpdateTaskCommandDecision({ command }),
      "ask",
      `${command} 在极简自动权限下必须单次确认`,
    );
  }
});

test("non-destructive reset variants stay allowed", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --soft HEAD~1" }), "allow");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --mixed HEAD~1" }), "allow");
});

test("unparseable or dynamic commands never auto-allow", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git $sub origin" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git " }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision(undefined), "ask");
});

test("legacy minimal auto-permission asks for remote/destructive git", () => {
  // 写远端与破坏性操作降为单次确认；只读检查照常放行。
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git push origin HEAD" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git merge origin/main" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --hard" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git diff v1..v2" }), "allow");
});

test("permission service enforces the policy inside the auto mode", () => {
  const service = new PermissionService();
  const capability = { riskLevel: "high" as const, needsApproval: true, readOnly: false };

  const push = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "git push origin HEAD" },
      riskLevel: "high",
      mode: "minimal",
    },
    capability,
  );
  assert.equal(push.decision, "ask", "写远端操作必须单次确认");
  assert.equal(push.ruleId, "mode.minimal.confirmDestructive");

  const minimalReset = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "git reset --hard" },
      riskLevel: "high",
      mode: "minimal",
    },
    capability,
  );
  assert.equal(minimalReset.decision, "ask");
  assert.equal(minimalReset.ruleId, "mode.minimal.confirmDestructive");

  const commit = service.checkPermission(
    {
      toolName: "Bash",
      input: { command: "git commit -m wip" },
      riskLevel: "high",
      mode: "minimal",
    },
    capability,
  );
  assert.equal(commit.decision, "ask", "不自动提交是批准边界，必须单次确认");
  assert.equal(commit.ruleId, "mode.minimal.confirmDestructive");

  const diff = service.checkPermission(
    { toolName: "Bash", input: { command: "git diff v1..v2" }, riskLevel: "high", mode: "minimal" },
    capability,
  );
  assert.equal(diff.decision, "allow");
  assert.equal(diff.ruleId, "mode.minimal");

  // 非 Bash 工具不受命令策略影响，保持模式自动放行语义。
  const write = service.checkPermission(
    { toolName: "Write", input: { file_path: "src/a.ts" }, riskLevel: "medium", mode: "minimal" },
    capability,
  );
  assert.equal(write.decision, "allow");
  assert.equal(write.ruleId, "mode.minimal");
});

test("project deny still wins over the auto modes", () => {
  const service = new PermissionService();
  const decision = service.checkPermission(
    { toolName: "Bash", input: { command: "git diff" }, riskLevel: "high", mode: "minimal" },
    { riskLevel: "high", needsApproval: true, readOnly: false },
    { version: 1, deny: [{ toolName: "Bash" }] },
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.project.deny");
});
