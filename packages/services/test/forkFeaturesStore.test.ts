import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FORK_FEATURES } from "@zcode/shared";
import {
  pickForkFeatures,
  readForkFeaturesFile,
  resolveForkFeaturesFilePath,
  writeForkFeaturesFile,
} from "../src/setting/forkFeaturesStore.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-fork-features-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("forkFeaturesStore", () => {
  it("独立文件与 setting.json 同目录", () => {
    const dir = join(makeTempDir(), ".zcode", "v2");
    expect(resolveForkFeaturesFilePath(join(dir, "setting.json"))).toBe(
      join(dir, "fork-features.json"),
    );
  });

  it("文件缺失时返回 exists=false 且不抛", async () => {
    const file = join(makeTempDir(), "fork-features.json");
    await expect(readForkFeaturesFile(file)).resolves.toEqual({ exists: false });
  });

  it("写入后读回一致，且不残留锁文件", async () => {
    const dir = makeTempDir();
    const file = join(dir, "fork-features.json");
    const value = { ...DEFAULT_FORK_FEATURES, monitorTool: true, memoryCapture: true };
    await writeForkFeaturesFile(file, value);

    expect(await readForkFeaturesFile(file)).toEqual({ exists: true, value });
    expect(readFileSync(file, "utf-8")).toContain('"monitorTool": true');
    expect(readdirSync(dir).filter((name) => name.includes(".lock"))).toEqual([]);
  });

  it("未知键被忽略、缺失键补默认，不因版本差异判成坏文件", async () => {
    const dir = makeTempDir();
    const file = join(dir, "fork-features.json");
    writeFileSync(file, JSON.stringify({ monitorTool: true, futureSwitch: true }), "utf-8");

    expect(await readForkFeaturesFile(file)).toEqual({
      exists: true,
      value: { ...DEFAULT_FORK_FEATURES, monitorTool: true },
    });
  });

  it("坏 JSON 隔离为 .corrupt-* 并降级为默认值", async () => {
    const dir = makeTempDir();
    const file = join(dir, "fork-features.json");
    writeFileSync(file, "{ not json", "utf-8");

    await expect(readForkFeaturesFile(file)).resolves.toEqual({ exists: true });
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("fork-features.json.corrupt-"))).toBe(
      true,
    );
  });

  it("pickForkFeatures 只接受布尔已知键", () => {
    expect(pickForkFeatures(undefined)).toBeUndefined();
    expect(pickForkFeatures([])).toBeUndefined();
    expect(pickForkFeatures({})).toBeUndefined();
    expect(pickForkFeatures({ monitorTool: "yes" })).toBeUndefined();
    expect(pickForkFeatures({ monitorTool: true, junk: 1 })).toEqual({
      ...DEFAULT_FORK_FEATURES,
      monitorTool: true,
    });
  });
});
