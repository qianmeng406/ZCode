import { access, rename, rm } from "node:fs/promises";

export const ASAR_UNPACK_NATIVE_GLOB = "*.{node,dll,dylib,exe}";

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createAppAsarPackArgs({ sourceDir, destinationPath, targetPlatformKey }) {
  return [
    "pack",
    sourceDir,
    destinationPath,
    "--unpack",
    ASAR_UNPACK_NATIVE_GLOB,
    "--unpack-dir",
    `node_modules/node-pty/prebuilds/${targetPlatformKey}`,
  ];
}

export async function replaceAppAsarFromStaging({
  sourceDir,
  appAsarPath,
  targetPlatformKey,
  runAsarCommand,
}) {
  const candidateAsarPath = `${appAsarPath}.next`;
  const candidateUnpackedPath = `${candidateAsarPath}.unpacked`;
  const unpackedPath = `${appAsarPath}.unpacked`;

  await Promise.all([
    rm(candidateAsarPath, { force: true, recursive: true }),
    rm(candidateUnpackedPath, { force: true, recursive: true }),
  ]);

  try {
    runAsarCommand(
      createAppAsarPackArgs({
        sourceDir,
        destinationPath: candidateAsarPath,
        targetPlatformKey,
      }),
    );

    if (!(await pathExists(candidateAsarPath)) || !(await pathExists(candidateUnpackedPath))) {
      // CI 的 TMPDIR 位于隐藏目录 `.tmp`。旧 glob 含 `**/`，@electron/asar 用绝对路径
      // 匹配时不会跨过隐藏目录，导致 native 被写回 asar，同时遗留旧 unpacked 形成物理双份。
      throw new Error(`重打包结果缺少 app.asar 或 app.asar.unpacked: ${candidateAsarPath}`);
    }

    // 先完整生成候选文件，再替换旧 archive 和 sidecar；不会把上一次打包的跨平台 native 留在 unpacked。
    // 第一步就把旧 app.asar 改名挪走：改名只需要 DELETE 权限，比 rm+rename 更容易成功；
    // 若产物正被运行中的应用占用（EBUSY/EPERM），在这里就失败，unpacked 与 archive 都还没动，
    // 不会留下「新 unpacked + 旧 asar」的半换状态。
    const retiredAsarPath = `${appAsarPath}.retired`;
    await rm(retiredAsarPath, { force: true, recursive: true });
    try {
      await rename(appAsarPath, retiredAsarPath);
    } catch (error) {
      if (error.code === "EBUSY" || error.code === "EPERM") {
        throw new Error(
          `app.asar 被占用（可能是正在运行的 ZCode），请先退出应用再打包: ${appAsarPath}`,
        );
      }
      throw error;
    }
    await rm(unpackedPath, { force: true, recursive: true });
    await rename(candidateUnpackedPath, unpackedPath);
    await rename(candidateAsarPath, appAsarPath);
    // 旧 archive 此时已无引用；删除失败不阻塞打包，只留下一个待清理文件。
    await rm(retiredAsarPath, { force: true }).catch(() => {});
  } finally {
    await Promise.all([
      rm(candidateAsarPath, { force: true, recursive: true }),
      rm(candidateUnpackedPath, { force: true, recursive: true }),
    ]);
  }
}
