import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSmokeArgs } from "../scripts/wsl-workspace-smoke-args.js";
import { resolveEffectiveAssetsRoot } from "../scripts/wsl-workspace-smoke-assets.js";

function validArgs(): string[] {
  return [
    "--distro",
    "Ubuntu-24.04",
    "--user",
    "zcodewslp2",
    "--workspace",
    "/home/zcodewslp2/workspace",
    "--mock-cdn-dir",
    "C:/lab/phase2/assets",
    "--output",
    "C:/lab/out/wsl-smoke-result.json",
  ];
}

const tempRoots: string[] = [];
afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("wsl-workspace-smoke 参数解析", () => {
  it("显式完整参数通过并绝对化本地路径", () => {
    const options = parseSmokeArgs(validArgs());
    expect(options.distro).toBe("Ubuntu-24.04");
    expect(options.user).toBe("zcodewslp2");
    expect(options.workspace).toBe("/home/zcodewslp2/workspace");
    expect(options.mockCdnDir).toMatch(/assets$/);
    expect(options.output).toMatch(/wsl-smoke-result\.json$/);
  });

  it("缺少任一必填参数时 fail-fast", () => {
    for (const flag of ["--distro", "--user", "--workspace", "--mock-cdn-dir", "--output"]) {
      const argv = validArgs();
      const index = argv.indexOf(flag);
      expect(() => parseSmokeArgs([...argv.slice(0, index), ...argv.slice(index + 2)])).toThrow(
        new RegExp(`缺少必填参数 ${flag}`),
      );
    }
  });

  it("空参直接失败", () => {
    expect(() => parseSmokeArgs([])).toThrow(/缺少必填参数/);
  });

  it("未知参数 fail-fast", () => {
    expect(() => parseSmokeArgs([...validArgs(), "--extra", "x"])).toThrow(/未知参数/);
  });

  it("参数缺值 fail-fast", () => {
    expect(() => parseSmokeArgs(["--distro"])).toThrow(/缺少值/);
    expect(() => parseSmokeArgs(["--distro", "--user"])).toThrow(/缺少值/);
  });

  it("重复参数 fail-fast", () => {
    expect(() => parseSmokeArgs([...validArgs(), "--user", "someone"])).toThrow(/重复/);
  });

  it("workspace 必须是 POSIX 绝对路径且无控制字符与 .. 段", () => {
    const cases = ["C:\\home\\x", "relative/path", "/a\nb", "/a\u0000b", "/a/../b", "/.."];
    for (const workspace of cases) {
      const argv = validArgs();
      argv[argv.indexOf("--workspace") + 1] = workspace;
      expect(() => parseSmokeArgs(argv)).toThrow();
    }
  });

  it("user 不安全字符 fail-fast", () => {
    const argv = validArgs();
    argv[argv.indexOf("--user") + 1] = "bad user;rm";
    expect(() => parseSmokeArgs(argv)).toThrow(/合法 POSIX 用户名/);
  });

  it("distro 不安全字符 fail-fast", () => {
    const argv = validArgs();
    argv[argv.indexOf("--distro") + 1] = "Ubuntu;rm";
    expect(() => parseSmokeArgs(argv)).toThrow(/不安全字符/);
  });

  it("本地路径按原值校验绝对性（相对路径不静默拼接 cwd）", () => {
    const argv = validArgs();
    argv[argv.indexOf("--mock-cdn-dir") + 1] = "relative/assets";
    expect(() => parseSmokeArgs(argv)).toThrow(/mock-cdn-dir 必须是绝对路径/);
  });
});

describe("wsl-workspace-smoke 资源版本映射", () => {
  it("已有运行时版本目录时原样返回且无需清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsl-smoke-assets-"));
    tempRoots.push(root);
    const releaseDir = join(root, "releases", "0.0.0-dev");
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "stub");
    const result = await resolveEffectiveAssetsRoot(root);
    expect(result.root).toBe(root);
    expect(result.cleanup).toBeUndefined();
  });

  it("唯一真实版本目录映射成运行时版本 junction 并给出清理", async () => {
    const { ZCODE_VERSION } = await import("@zcode/shared");
    const root = await mkdtemp(join(tmpdir(), "wsl-smoke-assets-"));
    tempRoots.push(root);
    const releaseDir = join(root, "releases", "3.14.3");
    await mkdir(join(releaseDir, "server"), { recursive: true });
    await writeFile(join(releaseDir, "server", "zcode-server.cjs"), "stub");
    const result = await resolveEffectiveAssetsRoot(root);
    expect(result.root).not.toBe(root);
    expect(result.cleanup).toBeDefined();
    expect(
      existsSync(join(result.root, "releases", ZCODE_VERSION, "server", "zcode-server.cjs")),
    ).toBe(true);
    // 清理只删除临时映射目录，不触碰原目录。
    await result.cleanup!();
    expect(existsSync(result.root)).toBe(false);
    expect(existsSync(join(root, "releases", "3.14.3", "server", "zcode-server.cjs"))).toBe(true);
  });

  it("多版本目录时不隐式选择而是 fail-fast", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsl-smoke-assets-"));
    tempRoots.push(root);
    for (const version of ["3.14.2", "3.14.3"]) {
      await mkdir(join(root, "releases", version), { recursive: true });
    }
    await expect(resolveEffectiveAssetsRoot(root)).rejects.toThrow(/多个版本目录/);
  });

  it("releases 缺失时 fail-fast", async () => {
    const root = await mkdtemp(join(tmpdir(), "wsl-smoke-assets-"));
    tempRoots.push(root);
    await expect(resolveEffectiveAssetsRoot(root)).rejects.toThrow(/releases/);
  });
});
