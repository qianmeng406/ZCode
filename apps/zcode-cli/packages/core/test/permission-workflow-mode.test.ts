import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";

test("yolo keeps its own rule id", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "yolo",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.yolo");
});

test("minimal mode executes commands and edits with its own rule id", () => {
  // 极简模式的权限与上下文一样极简：自动执行、不逐次确认（同完全访问姿态）。
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "minimal",
  });
  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.minimal");
});

test("minimal mode does not bypass plan-mode restrictions when plan is enabled", () => {
  const service = new PermissionService();
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "npm run build" },
    riskLevel: "medium",
    mode: "minimal",
    planEnabled: true,
  });
  // plan 分支先于模式放行：非只读命令必须仍然拒绝，不能借极简模式绕过。
  assert.equal(decision.decision, "deny");
});

test("minimal mode still honors user-configured disallowedTools", () => {
  // 放行排在 disallowedTools 之后：用户显式禁用清单是比「完整权限」更强的意图表达。
  const service = new PermissionService({
    allowedTools: new Set<string>(),
    disallowedTools: new Set(["Bash"]),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const decision = service.checkPermission({
    toolName: "Bash",
    input: { command: "ls" },
    riskLevel: "medium",
    mode: "minimal",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});
