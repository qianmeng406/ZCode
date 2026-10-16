import { getRemoteRuntimeToolsForPlatform, type RemoteResourcePackageId } from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@zcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@zcode/server/remote/remoteAssetInstaller.js";
import { buildWriteLiteralFileCommand } from "@zcode/server/remote/posixShell.js";
import { remoteExistsMany } from "@zcode/server/remote/remoteExistsMany.js";
import { remoteReadFiles } from "@zcode/server/remote/remoteReadFiles.js";

const REMOTE_TOOLS_BASE = `${REMOTE_BASE}/tools`;

export interface DeployRuntimeToolOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
}

export async function deployRuntimeTools(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployRuntimeToolOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const platformArch = options.platformArch;

  const tools = getRemoteRuntimeToolsForPlatform(env.platform).flatMap(
    ({ toolId, runtime, version }) => {
      const componentId = runtime.bundledResourceDir as RemoteResourcePackageId;
      if (
        options.selectedResourcePackageIds &&
        !options.selectedResourcePackageIds.includes(componentId)
      ) {
        loggers.log(`[tool-deploy] ${toolId}: 未选择资源包 ${componentId}，跳过检查和部署`);
        return [];
      }

      const entrySegments = runtime.resolveEntrySegments(env.platform);
      const binaryName = entrySegments[entrySegments.length - 1];
      if (!binaryName) {
        loggers.logWarn(`[tool-deploy] ${toolId}: 无法解析 binary 名称，跳过部署`);
        return [];
      }

      const remoteToolDir = `${REMOTE_TOOLS_BASE}/${runtime.bundledResourceDir}`;
      const remoteVersionFile = `${remoteToolDir}/.version`;
      const remoteBinaryPath = `${remoteToolDir}/${binaryName}`;
      return [
        { toolId, runtime, version, componentId, binaryName, remoteVersionFile, remoteBinaryPath },
      ];
    },
  );

  // 版本和 binary 属于本次持锁核对；合并往返但不跨连接或安装锁缓存。
  const versions = await remoteReadFiles(
    backend,
    tools.map((tool) => tool.remoteVersionFile),
  );
  const matchingTools = tools.filter((tool, index) => versions[index]?.trim() === tool.version);
  const binaryExists = await remoteExistsMany(
    backend,
    matchingTools.map((tool) => tool.remoteBinaryPath),
  );
  const currentBinaries = new Map(
    matchingTools.map((tool, index) => [tool.remoteBinaryPath, binaryExists[index]]),
  );

  for (const {
    toolId,
    runtime,
    version,
    componentId,
    binaryName,
    remoteVersionFile,
    remoteBinaryPath,
  } of tools) {
    if (currentBinaries.has(remoteBinaryPath)) {
      const hasRemoteBinary = currentBinaries.get(remoteBinaryPath);
      if (hasRemoteBinary) {
        loggers.log(`[tool-deploy] ${toolId}: 远程版本 ${version} 已是最新，跳过`);
        continue;
      }
      loggers.logWarn(
        `[remote-assets] ${options.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${runtime.bundledResourceDir} reason=remote binary missing path=${remoteBinaryPath}`,
      );
    }

    loggers.log(`[tool-deploy] ${toolId}: 开始部署 ${version}`);
    await options.installer.installFile({
      componentId,
      sourceRelativePath: `tools/${platformArch}/${runtime.bundledResourceDir}/${binaryName}`,
      remotePath: remoteBinaryPath,
      executable: true,
    });

    const versionStream = await backend.exec(
      buildWriteLiteralFileCommand(remoteVersionFile, version),
    );
    await waitForClose(versionStream);
    loggers.log(`[tool-deploy] ${toolId}: 部署完成 ${version}`);
  }
}
