import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { resolveIncrementalBaselinePath, resolveIncrementalPlatformKey, writeIncrementalBaseline } =
  await import("../scripts/incremental-app-asar.mjs");

/**
 * 增量基线的写入口径。
 *
 * 实测踩过的死锁（2026-11-12）：只有增量路径写 baseline，完整打包不写，于是
 * `pnpm-lock.yaml` 一变就要求「先完整打包一次」，而完整打包又不刷新 packedAt，
 * 下次仍判定 lock 比基线新——本机基线停在 2026-10-29，之后每次出包都是约 40
 * 分钟的全量。修复方式是把写基线抽成单一入口，两条路径都调用。
 */
describe("增量基线写入", () => {
  it("平台 key 与增量读取端同源（win → win32，mac → darwin）", () => {
    // 手写 `${os}-${arch}` 会写成 "win-x64"，与读取端的 "win32-x64" 不等，
    // canReuseStaging 永远失败、每次增量都重新解包 455MB 的 asar。
    expect(resolveIncrementalPlatformKey({ targetOs: "win", arch: "x64" })).toBe("win32-x64");
    expect(resolveIncrementalPlatformKey({ targetOs: "win32", arch: "x64" })).toBe("win32-x64");
    expect(resolveIncrementalPlatformKey({ targetOs: "mac", arch: "arm64" })).toBe("darwin-arm64");
    expect(resolveIncrementalPlatformKey({ targetOs: "darwin", arch: "arm64" })).toBe(
      "darwin-arm64",
    );
    expect(resolveIncrementalPlatformKey({ targetOs: "linux", arch: "x64" })).toBe("linux-x64");
  });

  it("写入后 packedAt / targetPlatformKey / appAsar 签名齐备，且目录不存在时自动创建", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-baseline-"));
    try {
      const asarPath = join(root, "fake.asar");
      writeFileSync(asarPath, "payload");
      const before = Date.now();
      const markerPath = writeIncrementalBaseline({
        desktopRoot: root,
        appAsarPath: asarPath,
        targetPlatformKey: "win32-x64",
      });
      expect(markerPath).toBe(resolveIncrementalBaselinePath(root));
      const written = JSON.parse(readFileSync(markerPath, "utf8"));
      expect(written.targetPlatformKey).toBe("win32-x64");
      expect(written.packedAt).toBeGreaterThanOrEqual(before);
      // 签名取自真实产物：增量据此判断"产物是否被换过"。
      expect(written.appAsar.size).toBe(statSync(asarPath).size);
      expect(written.appAsar.mtimeMs).toBe(Math.trunc(statSync(asarPath).mtimeMs));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 源码级护栏：完整打包路径必须写基线。
 *
 * 这是"死锁"的根因所在，且它是控制流（不是纯函数），无法用单测直接跑 electron-builder
 * 那一段——所以扫描源码钉住"else 分支里确实调了 writeIncrementalBaseline"。
 */
describe("完整打包也要刷新增量基线（解开 lock 变化的死锁）", () => {
  const bundleSource = readFileSync("packages/desktop/scripts/bundle.mjs", "utf8");

  it("完整打包分支（else）里调用了 writeIncrementalBaseline", () => {
    const elseBranch = /else \{[\s\S]{0,1200}?writeIncrementalBaseline\(/u.exec(bundleSource)?.[0];
    expect(elseBranch).toBeDefined();
    // 必须在 electron-builder 之后写：产物还没生成时写的签名是错的。
    expect(elseBranch).toContain("runElectronBuilderWithRetry");
  });

  it("完整打包用的是共用的平台 key 归一函数，不是手写映射", () => {
    const usage = /writeIncrementalBaseline\(\{[\s\S]{0,400}?\}\)/u.exec(bundleSource)?.[0];
    expect(usage).toBeDefined();
    expect(usage).toContain("resolveIncrementalPlatformKey(");
    // 反证：不允许手写 `os === "mac" ? "darwin" : os` 这种映射（历史 bug 的写法）。
    expect(usage).not.toMatch(/`\$\{os === "mac"/u);
  });
});
