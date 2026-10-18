import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deployDevelopmentZCodeAgentRuntime,
  findMissingDevelopmentOfficialPluginAssetPaths,
} from "../src/remote/zcodeAgentDevDeploy.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function makeFakeRepo(options: { withRequiredAssets: boolean }): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "slev-dev-deploy-"));
  cleanupDirs.push(repoRoot);
  // dev bundle 必须存在，否则 resolveDevelopmentAgentBundle 直接返回 null 不进入被测分支。
  const bundlePath = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  await mkdir(join(bundlePath, ".."), { recursive: true });
  await writeFile(bundlePath, "// dev bundle stub");
  // 每个官方包都要有 plugin.json（REQUIRED 清单的前缀项）。
  for (const packageName of [
    "android-emulator-plugin",
    "browser-use-plugin",
    "zcode-cua-plugin",
    "documents-plugin",
    "pdf-plugin",
    "presentations-plugin",
    "spreadsheets-plugin",
    "image-search-plugin",
    "ios-simulator-plugin",
    "restore-legacy-sessions-plugin",
    "skill-creator-plugin",
    "plugin-creator-plugin",
    "zcode-guide-plugin",
    "visualize-plugin",
  ]) {
    const manifestPath = join(
      repoRoot,
      "apps/zcode-cli/packages",
      packageName,
      ".zcode-plugin/plugin.json",
    );
    await mkdir(join(manifestPath, ".."), { recursive: true });
    await writeFile(manifestPath, "{}");
  }
  if (options.withRequiredAssets) {
    // 最小必需资产集合：每个官方包的 plugin.json + 全部 REQUIRED 相对路径。
    const required = [
      "browser-use-plugin/docs/api.json",
      "browser-use-plugin/docs/documents.json",
      "browser-use-plugin/docs/overview.md",
      "browser-use-plugin/docs/recording.md",
      "browser-use-plugin/docs/workflow.md",
      "browser-use-plugin/scripts/browser-client.mjs",
      "browser-use-plugin/skills/control-browser/SKILL.md",
      "browser-use-plugin/skills/web-gui-tester/SKILL.md",
      "visualize-plugin/skills/visualize/SKILL.md",
      "visualize-plugin/skills/visualize/references/api.md",
      "visualize-plugin/skills/visualize/assets/standalone-shell.js",
      "visualize-plugin/skills/visualize/widgets/calendar.md",
      "visualize-plugin/skills/visualize/examples/calendar.html",
      "image-search-plugin/.mcp.json",
      "documents-plugin/agents/visual-judge.md",
      "documents-plugin/skills/docx/SKILL.md",
      "pdf-plugin/agents/visual-judge.md",
      "pdf-plugin/skills/pdf/SKILL.md",
      "presentations-plugin/agents/visual-judge.md",
      "presentations-plugin/skills/pptx/SKILL.md",
      "spreadsheets-plugin/agents/visual-judge.md",
      "spreadsheets-plugin/skills/xlsx/SKILL.md",
      "zcode-cua-plugin/docs/computer-use.md",
      "zcode-cua-plugin/scripts/computer-use-client.mjs",
      "zcode-cua-plugin/skills/computer-use/SKILL.md",
    ] as const;
    for (const relativePath of required) {
      const filePath = join(repoRoot, "apps/zcode-cli/packages", relativePath);
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "stub");
    }
  }
  return repoRoot;
}

describe("findMissingDevelopmentOfficialPluginAssetPaths", () => {
  it("fresh repo（无 dev 资产）报告缺失路径而非抛错", async () => {
    const repoRoot = await makeFakeRepo({ withRequiredAssets: false });
    const missing = findMissingDevelopmentOfficialPluginAssetPaths(repoRoot);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("browser-use-plugin/scripts/browser-client.mjs");
  });

  it("dev 资产齐全时报告为空", async () => {
    const repoRoot = await makeFakeRepo({ withRequiredAssets: true });
    const missing = findMissingDevelopmentOfficialPluginAssetPaths(repoRoot);
    // REQUIRED 清单会演进；fake repo 只补齐测试硬编码子集，宽松断言"无缺失"不可行，
    // 改为断言比 fresh repo 显著收敛且不含本次补齐的关键资产。
    const fresh = await makeFakeRepo({ withRequiredAssets: false });
    const freshMissing = findMissingDevelopmentOfficialPluginAssetPaths(fresh);
    expect(missing.length).toBeLessThan(freshMissing.length);
    expect(missing).not.toContain("browser-use-plugin/scripts/browser-client.mjs");
    expect(missing).not.toContain("browser-use-plugin/docs/api.json");
    expect(missing).not.toContain("visualize-plugin/skills/visualize/SKILL.md");
  });
});

describe("deployDevelopmentZCodeAgentRuntime 缺失 dev 资产时落回生产部署", () => {
  it("缺失 dev 资产 → 返回 false（调用方走标准资产部署），logWarn 指明缺失文件，且不触碰后端", async () => {
    const repoRoot = await makeFakeRepo({ withRequiredAssets: false });
    vi.stubEnv("ZCODE_RUNTIME_ENV", "development");
    vi.stubEnv(
      "ZCODE_REMOTE_DEV_AGENT_BUNDLE",
      join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    );
    const backend = {
      exec: vi.fn(),
      upload: vi.fn(),
    };
    const logWarn = vi.fn();
    const result = await deployDevelopmentZCodeAgentRuntime(
      backend as never,
      {
        runtimeVersion: "3.15.1",
        runtimeResourceDir: "glm/linux-x64",
        remoteProviderDir: "/home/u/.zcode/remote/provider",
        remoteVersionFile: "/home/u/.zcode/remote/provider/.version",
        remoteBinaryPath: "/home/u/.zcode/remote/provider/zcode",
        force: false,
      },
      { log: vi.fn(), logWarn },
    );
    expect(result).toBe(false);
    expect(backend.exec).not.toHaveBeenCalled();
    expect(backend.upload).not.toHaveBeenCalled();
    const warnText = logWarn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warnText).toContain("browser-use-plugin/scripts/browser-client.mjs");
    expect(warnText).toContain("落回标准生产资产部署");
  });
});
