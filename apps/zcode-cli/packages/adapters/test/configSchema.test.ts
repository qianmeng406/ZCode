import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.js";

test("legacy workflow permission.mode is dropped instead of failing the whole config", () => {
  // 项目开发模式已移除：写着 "mode": "workflow" 的旧配置必须在读取边界降级，
  // 回退到默认档位（mode 缺席 → build），而不是抛 ZodError 让整份配置失效。
  const result = parseConfigFileToRuntimePatchWithDiagnostics({
    permission: { mode: "workflow", allowedTools: ["Bash"] },
  });
  assert.equal(result.config.permission?.mode, undefined);
  assert.deepEqual(result.config.permission?.allowedTools, ["Bash"]);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "config_permission_mode_invalid"),
  );
});

test("a valid permission.mode still parses cleanly", () => {
  const result = parseConfigFileToRuntimePatchWithDiagnostics({ permission: { mode: "edit" } });
  assert.equal(result.config.permission?.mode, "edit");
  assert.equal(result.diagnostics.length, 0);
});
