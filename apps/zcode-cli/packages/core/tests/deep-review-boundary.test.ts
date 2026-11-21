import { describe, expect, it } from "vitest";
import { evaluateDeepReviewToolPolicy } from "../src/runtime/methods/workspace-deep-review.js";

/**
 * B1-02 深度审查边界：文件工具与 Bash 的工作区包含判定。
 *
 * 这一组钉住「策略函数不因工具入参名不同而漏检」。原「$HOME 绕过」结论已在方案 1.2
 * 撤回（动态展开会先被只读 AST 校验拒绝），这里只做全链路防御验证，不重复已存在的拦截。
 *
 * 注：`evaluateDeepReviewToolPolicy` 的既有用例在 `test/workspace-deep-review.test.ts`
 * （node:test 风格，不在 `vitest tests` 的收集范围）。策略边界是本批次的验收面，
 * 因此在这里补的用例会真正被 CI 跑到。
 */

const runtime = {
  workingDirectory: "/repo",
  workspaceRoot: "/repo",
} as unknown as Parameters<typeof evaluateDeepReviewToolPolicy>[1];

function call(name: string, input: unknown) {
  return { id: "call-1", name, input } as unknown as Parameters<
    typeof evaluateDeepReviewToolPolicy
  >[0];
}

function allowed(name: string, input: unknown): boolean {
  return evaluateDeepReviewToolPolicy(call(name, input), runtime).allowed;
}

describe("Glob 的 pattern 不能绕过工作区边界（B1-02）", () => {
  it("父目录相对 pattern 一律拒绝", () => {
    // 缺陷：Glob 的真实入参是 { pattern, path }，而策略函数只读了 "glob"/"path"，
    // 从未检查 pattern —— Read/Grep 的 "../x" 被拦、Glob 的 "../**" 却放行。
    for (const pattern of [
      "../**",
      "../*",
      "..",
      "../x/.env",
      "../../../**",
      "**/../../etc",
      "..\\**",
    ]) {
      expect(allowed("Glob", { pattern }), `pattern=${pattern}`).toBe(false);
    }
  });

  it("工作区内的 pattern 仍然放行（不扩大误伤）", () => {
    for (const pattern of ["**/*.ts", "src/**", "*.md", "src/deep/**/*.test.ts"]) {
      expect(allowed("Glob", { pattern }), `pattern=${pattern}`).toBe(true);
    }
  });

  it("Glob 的 path 字段原有的边界判定不变", () => {
    expect(allowed("Glob", { pattern: "**/*.ts", path: "../outside" })).toBe(false);
    expect(allowed("Glob", { pattern: "**/*.ts", path: "src" })).toBe(true);
  });
});

describe("Read/Grep 的路径边界保持（回归守卫）", () => {
  it("父目录与 HOME 相对路径拒绝", () => {
    for (const [name, field] of [
      ["Read", "file_path"],
      ["Grep", "path"],
    ] as const) {
      for (const p of ["../x", "../x/.env", "~", "~/secrets.txt"]) {
        expect(allowed(name, { [field]: p }), `${name} ${p}`).toBe(false);
      }
    }
  });

  it("工作区内路径放行", () => {
    expect(allowed("Read", { file_path: "src/a.ts" })).toBe(true);
    expect(allowed("Read", { file_path: "/repo/src/a.ts" })).toBe(true);
    expect(allowed("Grep", { pattern: "x", path: "src" })).toBe(true);
  });
});

describe("Bash 的写入/外部路径仍被拒（回归守卫）", () => {
  it("重定向到工作区外、选项值里的外部路径、命令替换都拒绝", () => {
    for (const command of [
      "cat a.ts > /etc/passwd",
      "ls 2> /tmp/out.txt",
      "cat a.ts >> ../../../etc/x",
      "grep -f /etc/passwd a.ts",
      "find / -name x",
      "git --git-dir=/other/.git log",
      "cat $(echo /etc/passwd)",
      "cat $HOME/x",
      "cat ${HOME}/x",
    ]) {
      expect(allowed("Bash", { command }), command).toBe(false);
    }
  });

  it("工作区内的只读取证命令放行", () => {
    // 注意：git 只读判定还会校验 cwd 真实可解析（isGitRuntimeContextUnsafe 用
    // canonicalPath），虚拟路径会让 git 命令一律被判不安全——那条与边界扫描无关，
    // 这里只验证路径扫描不误伤非 git 的只读命令。
    for (const command of ["ls src", "cat src/a.ts", "grep -n TODO src/a.ts", "wc -l src/a.ts"]) {
      expect(allowed("Bash", { command }), command).toBe(true);
    }
  });
});
