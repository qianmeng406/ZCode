import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectMemoryWorkspaceId } from "@zcode/shared/node";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";

/** 重构前的公式：目录名一旦变化，已有记忆会全部失联。 */
function legacyWorkspaceId(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  platform?: string;
}): string {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const normalizedWorkspacePath = resolve(input.workspacePath);
  const keySource =
    workspaceIdentity ||
    ((input.platform ?? process.platform) === "win32"
      ? normalizedWorkspacePath.toLowerCase()
      : normalizedWorkspacePath);
  const hash = createHash("sha256").update(keySource).digest("hex").slice(0, 16);
  const slug = workspaceIdentity
    ? "project"
    : (basename(normalizedWorkspacePath) || "project")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 48) || "project";
  return `${slug}-${hash}`;
}

describe("Project Memory workspace id", () => {
  it("与重构前的目录名公式逐字节一致", () => {
    const cases = [
      { workspacePath: resolve("/work/My Project") },
      { workspacePath: resolve("/work/my project") },
      { workspacePath: resolve("/work/workspace") },
      { workspacePath: resolve("/work/workspace"), workspaceIdentity: "acme/remote" },
      { workspacePath: resolve("/work/workspace"), workspaceIdentity: "  " },
      { workspacePath: resolve("/work/---Weird Name!!!___") },
    ];
    for (const testCase of cases) {
      expect(
        resolveProjectMemoryWorkspaceId({
          workspacePath: testCase.workspacePath,
          ...(testCase.workspaceIdentity === undefined
            ? {}
            : { workspaceIdentity: testCase.workspaceIdentity }),
          platform: process.platform,
        }),
      ).toBe(legacyWorkspaceId(testCase));
    }
  });

  it("win32 折叠大小写，posix 不折叠", () => {
    const workspacePath = "/work/MixedCase";
    expect(resolveProjectMemoryWorkspaceId({ workspacePath, platform: "win32" })).toBe(
      resolveProjectMemoryWorkspaceId({
        workspacePath: workspacePath.toLowerCase(),
        platform: "win32",
      }),
    );
    expect(resolveProjectMemoryWorkspaceId({ workspacePath, platform: "linux" })).not.toBe(
      resolveProjectMemoryWorkspaceId({
        workspacePath: workspacePath.toLowerCase(),
        platform: "linux",
      }),
    );
  });

  it("workspaceIdentity 优先：slug 固定为 project，忽略工作区路径", () => {
    const withIdentity = resolveProjectMemoryWorkspaceId({
      workspacePath: "/one",
      workspaceIdentity: "remote-identity",
      platform: "linux",
    });
    expect(withIdentity.startsWith("project-")).toBe(true);
    expect(
      resolveProjectMemoryWorkspaceId({
        workspacePath: "/two",
        workspaceIdentity: "remote-identity",
        platform: "linux",
      }),
    ).toBe(withIdentity);
  });

  it("resolveProjectMemoryRoot 拼出 memories/projects/<id>/memory", () => {
    const root = resolveProjectMemoryRoot({
      cliStorageRoot: resolve("/storage"),
      workspacePath: resolve("/work/My Project"),
    });
    expect(root).toBe(
      join(
        resolve("/storage"),
        "memories",
        "projects",
        legacyWorkspaceId({ workspacePath: resolve("/work/My Project") }),
        "memory",
      ),
    );
  });
});
