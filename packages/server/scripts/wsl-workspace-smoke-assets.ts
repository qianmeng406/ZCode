import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";

/**
 * tsx 直跑源码时 bundler 的 __ZCODE_VERSION__ 未注入，ZCODE_VERSION 退化成 "0.0.0-dev"，
 * 而随包资源目录是按真实版本命名的（如 releases/3.14.3），部署链路会按 ZCODE_VERSION 去找。
 * 这里把真实 release 目录映射成运行时看到的版本号（junction），让源码态验收与打包态行为一致。
 *
 * 仅当本地目录里没有运行时版本目录时才创建临时映射；临时目录是本函数 mkdtemp 新建的，
 * 调用方持有后必须用 cleanupMappedAssetsRoot 在 finally 里删除，绝不触碰原始目录。
 * 返回 cleanup 为 undefined 表示未创建临时目录（直接复用原目录），无需清理。
 */
export async function resolveEffectiveAssetsRoot(
  localAssetsDir: string,
): Promise<{ root: string; cleanup?: () => Promise<void> }> {
  // Windows junction 必须用绝对目标路径：传入相对路径时 link 会指向错误位置。
  const absoluteAssetsDir = resolve(localAssetsDir);
  const releasesRoot = join(absoluteAssetsDir, "releases");
  if (existsSync(join(releasesRoot, ZCODE_VERSION))) {
    return { root: absoluteAssetsDir };
  }

  let dirents;
  try {
    dirents = await readdir(releasesRoot, { withFileTypes: true });
  } catch {
    throw new Error(`随包资源目录缺少 releases/: ${releasesRoot}`);
  }
  const versionDirs = dirents.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
  if (versionDirs.length === 0) {
    throw new Error(`随包资源 releases/ 下没有版本目录: ${releasesRoot}`);
  }

  // 不隐式选第一个版本：目录里必须能无歧义地给出一份产物。
  if (versionDirs.length > 1) {
    throw new Error(
      `随包资源 releases/ 有多个版本目录(${versionDirs.map((entry) => entry.name).join(", ")})，` +
        `源码态无法确定映射目标；请改用打包态运行或只保留一个版本目录`,
    );
  }

  const versionName = versionDirs[0]!.name;
  const sourceDir = join(releasesRoot, versionName);
  // mkdtemp 新建的目录是本函数独有资源：失败路径自己清，成功路径交给调用方 finally 清。
  const mappedRoot = await mkdtemp(join(tmpdir(), "zcode-wsl-smoke-assets-"));
  try {
    const mappedReleases = join(mappedRoot, "releases");
    await mkdir(mappedReleases, { recursive: true });
    await symlink(sourceDir, join(mappedReleases, versionName), "junction");
    const mappedVersionDir = join(mappedReleases, ZCODE_VERSION);
    await symlink(sourceDir, mappedVersionDir, "junction");

    // 映射后立即自校验：link 建失败时必须在部署前就停下，否则会误报"随包资源缺失"。
    const probePath = join(mappedVersionDir, "server", "zcode-server.cjs");
    if (!existsSync(probePath)) {
      throw new Error(`版本目录映射失败，无法读取 ${probePath}`);
    }
    console.log(
      `[assets] 运行时版本号为 ${ZCODE_VERSION}，已把 releases/${versionName} 映射为 releases/${ZCODE_VERSION}`,
    );
    return {
      root: mappedRoot,
      cleanup: () => rm(mappedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(mappedRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
