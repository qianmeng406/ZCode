import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPath,
  evaluateFiles,
  findSecretHits,
  formatViolations,
  isBinaryPath,
} from "../git-gate/file-policy.mjs";

test("禁止路径：env / 私钥 / 依赖 / 发布产物", () => {
  assert.equal(classifyPath(".env")?.rule, "env-file");
  assert.equal(classifyPath("config/.env.local")?.rule, "env-file");
  assert.equal(classifyPath(".env.example"), undefined);
  assert.equal(classifyPath("config/.env.template"), undefined);
  assert.equal(classifyPath("certs/server.pem")?.rule, "private-key-file");
  assert.equal(classifyPath("secrets/client.p12")?.rule, "private-key-file");
  assert.equal(classifyPath(".ssh/id_ed25519")?.rule, "ssh-private-key");
  assert.equal(classifyPath("node_modules/foo/index.js")?.rule, "vendored-dependencies");
  assert.equal(classifyPath("dist-release/app.zip")?.rule, "release-output");
  assert.equal(classifyPath("packages/services/src/foo.ts"), undefined);
});

test("二进制文件与测试/fixture 路径不做内容扫描", () => {
  assert.equal(isBinaryPath("assets/logo.png"), true);
  assert.equal(isBinaryPath("packages/services/src/foo.ts"), false);
  assert.deepEqual(findSecretHits("assets/logo.png", "-----BEGIN PRIVATE KEY-----"), []);
  assert.deepEqual(
    findSecretHits("packages/services/test/foo.test.ts", "-----BEGIN PRIVATE KEY-----"),
    [],
  );
  assert.deepEqual(
    findSecretHits("scripts/test/fixtures/key.ts", `const t = "ghp_${"c".repeat(36)}";`),
    [],
  );
  assert.equal(classifyPath("packages/services/test/.env")?.rule, "env-file", "路径规则仍生效");
});

test("高置信密钥模式命中，示例值放行", () => {
  const githubToken = `ghp_${"a".repeat(36)}`;
  assert.deepEqual(
    findSecretHits("src/config.ts", `const token = "${githubToken}";`).map((hit) => hit.rule),
    ["github-token"],
  );
  assert.deepEqual(
    findSecretHits("src/aws.ts", "const key = 'AKIAIOSFODNN7EXAMPLE';"),
    [],
    "带 EXAMPLE 的示例值放行",
  );
  assert.deepEqual(
    findSecretHits("src/aws.ts", "const key = 'AKIAABCDEFGHIJKLMNOP';").map((hit) => hit.rule),
    ["aws-access-key"],
  );
  assert.deepEqual(
    findSecretHits("src/key.ts", "-----BEGIN OPENSSH PRIVATE KEY-----").map((hit) => hit.rule),
    ["private-key-block"],
  );
  assert.deepEqual(
    findSecretHits("src/key.ts", `const key = "sk-ant-${"a".repeat(24)}";`).map((hit) => hit.rule),
    ["anthropic-key"],
  );
  assert.deepEqual(findSecretHits("src/notes.md", "token placeholder goes here"), []);
});

test("evaluateFiles 汇总路径与内容违规并格式化输出", () => {
  const violations = evaluateFiles([
    { path: ".env", content: "A=1\n" },
    { path: "src/config.ts", content: `export const token = "ghp_${"b".repeat(36)}";\n` },
    { path: "src/fine.ts", content: "export const ok = 1;\n" },
  ]);
  assert.deepEqual(
    violations.map((violation) => `${violation.path}:${violation.rule}`),
    [".env:env-file", "src/config.ts:github-token"],
  );
  const lines = formatViolations(violations);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /src\/config\.ts: github-token/u);
});
