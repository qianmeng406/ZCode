import assert from "node:assert/strict";
import test from "node:test";
import { resolveUpdateTaskCommandDecision } from "../src/tool/handlers/bash-update-task-policy.js";
import { PermissionService } from "../src/permission/service.js";

/**
 * 更新任务 / 旧极简自动权限的命令级执行边界：
 * 禁令与破坏性确认由 Bash AST 判定强制，不是 SOP 提示词纪律。
 * 命令只作为字符串参与判定，测试绝不真正执行任何 git/shell 命令。
 */

const UPDATE = { forbidMergeAndPush: true } as const;

test("update task denies merge/push family outright", () => {
  for (const command of [
    "git push origin HEAD",
    "git pull",
    "git merge origin/main",
    "git cherry-pick abc123",
    "git rebase origin/main",
  ]) {
    assert.equal(
      resolveUpdateTaskCommandDecision({ command }, UPDATE),
      "deny",
      `${command} 必须被禁令拦下`,
    );
  }
});

test("update task denies forbidden git even inside compound commands", () => {
  assert.equal(
    resolveUpdateTaskCommandDecision({ command: "echo ok && git push origin HEAD" }, UPDATE),
    "deny",
  );
  assert.equal(
    resolveUpdateTaskCommandDecision({ command: "git status; git pull" }, UPDATE),
    "deny",
  );
  // 全局选项不放宽：git -C 换目录照样命中子命令。
  assert.equal(
    resolveUpdateTaskCommandDecision({ command: "git -C /other/remote push" }, UPDATE),
    "deny",
  );
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
    assert.equal(
      resolveUpdateTaskCommandDecision({ command }, UPDATE),
      "ask",
      `${command} 必须单次确认`,
    );
  }
});

test("fetch asks (it is not read-only) while inspection commands allow", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git fetch origin --tags" }, UPDATE), "ask");
  for (const command of [
    "git status",
    "git log --oneline -5",
    "git diff v1..v2 --stat",
    "git ls-remote --tags origin",
    "pnpm typecheck",
    "rg -n TODO src",
  ]) {
    assert.equal(resolveUpdateTaskCommandDecision({ command }, UPDATE), "allow", command);
  }
});

test("plain stash and commit never auto-run (update boundary: no auto stash/commit)", () => {
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
      resolveUpdateTaskCommandDecision({ command }, UPDATE),
      "ask",
      `${command} 在更新任务中必须单次确认`,
    );
    assert.equal(
      resolveUpdateTaskCommandDecision({ command }),
      "ask",
      `${command} 在旧极简自动权限下也必须单次确认`,
    );
  }
});

test("non-destructive reset variants stay allowed", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --soft HEAD~1" }, UPDATE), "allow");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --mixed HEAD~1" }, UPDATE), "allow");
});

test("unparseable or dynamic commands never auto-allow", () => {
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git $sub origin" }, UPDATE), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git " }, UPDATE), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "" }, UPDATE), "ask");
  assert.equal(resolveUpdateTaskCommandDecision(undefined, UPDATE), "ask");
});

test("legacy minimal auto-permission asks for remote/destructive git but keeps merge/push legal", () => {
  // 旧极简不设禁令（历史语义保留），但写远端与破坏性操作降为单次确认。
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git push origin HEAD" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git merge origin/main" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git reset --hard" }), "ask");
  assert.equal(resolveUpdateTaskCommandDecision({ command: "git diff v1..v2" }), "allow");
});

test("permission service enforces the policy inside both auto modes", () => {
  const service = new PermissionService();
  const capability = { riskLevel: "high" as const, needsApproval: true, readOnly: false };

  const push = service.checkPermission(
    { toolName: "Bash", input: { command: "git push origin HEAD" }, riskLevel: "high", mode: "zcodeUpdate" },
    capability,
  );
  assert.equal(push.decision, "deny");
  assert.equal(push.ruleId, "mode.zcodeUpdate.gitForbidden");

  const reset = service.checkPermission(
    { toolName: "Bash", input: { command: "git reset --hard" }, riskLevel: "high", mode: "zcodeUpdate" },
    capability,
  );
  assert.equal(reset.decision, "ask");
  assert.equal(reset.ruleId, "mode.zcodeUpdate.confirmDestructive");

  const commit = service.checkPermission(
    { toolName: "Bash", input: { command: "git commit -m wip" }, riskLevel: "high", mode: "zcodeUpdate" },
    capability,
  );
  assert.equal(commit.decision, "ask", "不自动提交是批准边界，必须单次确认");
  assert.equal(commit.ruleId, "mode.zcodeUpdate.confirmDestructive");

  const diff = service.checkPermission(
    { toolName: "Bash", input: { command: "git diff v1..v2" }, riskLevel: "high", mode: "zcodeUpdate" },
    capability,
  );
  assert.equal(diff.decision, "allow");
  assert.equal(diff.ruleId, "mode.zcodeUpdate");

  const minimalReset = service.checkPermission(
    { toolName: "Bash", input: { command: "git reset --hard" }, riskLevel: "high", mode: "minimal" },
    capability,
  );
  assert.equal(minimalReset.decision, "ask");
  assert.equal(minimalReset.ruleId, "mode.minimal.confirmDestructive");

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
    { toolName: "Bash", input: { command: "git diff" }, riskLevel: "high", mode: "zcodeUpdate" },
    { riskLevel: "high", needsApproval: true, readOnly: false },
    { version: 1, deny: [{ toolName: "Bash" }] },
  );
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.project.deny");
});
