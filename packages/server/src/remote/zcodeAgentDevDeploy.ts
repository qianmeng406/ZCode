/* eslint-disable max-lines -- 开发态 agent 部署包含本地打包、远端 owner staging 与 wrapper 安装，后续独立拆分上传事务。 */
import { ZCODE_AGENT_PROVIDER, resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { remoteExistsMany } from "@zcode/server/remote/remoteExistsMany.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
  quotePosixShellArg,
} from "@zcode/server/remote/posixShell.js";
import { createTarGzArchive } from "@zcode/server/remote/localTarGz.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@zcode/server/remote/zcodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@zcode/server/remote/zcodeAgentWrapperDeploy.js";
import {
  REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS,
  REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
} from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@zcode/server/remote/zcodeAgentOfficialPluginPermissionRepair.js";

const DEV_AGENT_BUNDLE_RELATIVE_PATH = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const DEV_AGENT_BUNDLE_ENV = "ZCODE_REMOTE_DEV_AGENT_BUNDLE";
const REMOTE_DEV_AGENT_BUNDLE_NAME = REMOTE_AGENT_BUNDLE_NAME;
const REMOTE_DEV_AGENT_VERSION_FILE_NAME = ".dev-version";

interface DeployDevelopmentZCodeAgentRuntimeParams {
  runtimeVersion: string;
  runtimeResourceDir: string;
  remoteProviderDir: string;
  remoteVersionFile: string;
  remoteBinaryPath: string;
  force: boolean;
}

function findUpward(relativePath: string): { rootDir: string; path: string } | null {
  let current = resolve(process.cwd());
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return { rootDir: current, path: candidate };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function shouldUseDevelopmentAgentBundle(): boolean {
  if (resolveZCodeRuntimeEnv(process.env) !== "development") {
    return false;
  }

  const explicit = process.env[DEV_AGENT_BUNDLE_ENV]?.trim().toLowerCase();
  if (explicit === "0" || explicit === "false") {
    return false;
  }
  if (explicit === "1" || explicit === "true") {
    return true;
  }

  // Vitest 里仓库真实 dist 可能存在；默认关闭，避免普通部署测试误走开发态分支。
  // 测试可用 ZCODE_REMOTE_DEV_AGENT_BUNDLE 显式打开（同时仍要求 ZCODE_RUNTIME_ENV=development）。
  if (process.env.VITEST) {
    return Boolean(process.env[DEV_AGENT_BUNDLE_ENV]?.trim());
  }
  return true;
}

function resolveDevelopmentAgentBundle(): {
  repoRoot: string;
  localBundlePath: string;
} | null {
  if (!shouldUseDevelopmentAgentBundle()) {
    return null;
  }
  // 测试注入：显式指定 dev bundle 路径时，以该路径所在仓库为 repoRoot（不经 findUpward）。
  // 仅当注入值形如路径（含分隔符或 .cjs 后缀）才按路径处理；历史测试把该变量当布尔开关
  // （"1"）用，开关式必须回退 findUpward，否则开发态分支不可达、整组开发态部署测试回归。
  const injected = process.env[DEV_AGENT_BUNDLE_ENV]?.trim();
  if (process.env.VITEST && injected) {
    const looksLikePath =
      injected.includes("/") || injected.includes("\\") || injected.endsWith(".cjs");
    if (looksLikePath) {
      const localBundlePath = resolve(injected);
      if (!existsSync(localBundlePath)) {
        return null;
      }
      return { repoRoot: dirname(dirname(dirname(dirname(localBundlePath)))), localBundlePath };
    }
  }
  const found = findUpward(DEV_AGENT_BUNDLE_RELATIVE_PATH);
  return found ? { repoRoot: found.rootDir, localBundlePath: found.path } : null;
}

async function computeDevelopmentAgentAssetsSha256(params: {
  localBundlePath: string;
  repoRoot: string;
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update("bundle:zcode.cjs\n");
  hash.update(await readFile(params.localBundlePath));
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const packageRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    hash.update(`plugin:${packageName}\n`);
    await hashDevelopmentOfficialPluginPackage(hash, packageRoot, packageName);
  }
  const bundledSkillsRoot = join(params.repoRoot, "apps/zcode-cli/packages/bundled-skills");
  // bundled-skills 是随仓库提交的源文件：缺失按上游语义硬失败，不参与插件资产的落回。
  await assertDevelopmentOfficialPluginRequiredAssets(bundledSkillsRoot, "bundled-skills");
  await hashLocalPath(hash, bundledSkillsRoot, "bundled-skills");
  return hash.digest("hex");
}

async function hashDevelopmentOfficialPluginPackage(
  hash: ReturnType<typeof createHash>,
  packageRoot: string,
  packageName: string,
): Promise<void> {
  const manifestPath = join(packageRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
  }
  await assertDevelopmentOfficialPluginRequiredAssets(packageRoot, packageName);

  for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
    const sourcePath = join(packageRoot, topLevelPath);
    if (existsSync(sourcePath)) {
      await hashLocalPath(hash, sourcePath, `${packageName}/${topLevelPath}`);
    }
  }
}

async function hashLocalPath(
  hash: ReturnType<typeof createHash>,
  filePath: string,
  relativePath: string,
): Promise<void> {
  const fileStat = await lstat(filePath);
  if (fileStat.isDirectory()) {
    hash.update(`dir:${relativePath}\n`);
    const children = (await readdir(filePath)).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    for (const child of children) {
      await hashLocalPath(hash, join(filePath, child), `${relativePath}/${child}`);
    }
    return;
  }

  if (fileStat.isSymbolicLink()) {
    hash.update(`symlink:${relativePath}:${await readlink(filePath)}\n`);
    return;
  }

  if (!fileStat.isFile()) {
    return;
  }

  hash.update(`file:${relativePath}:${fileStat.mode & 0o777}:${fileStat.size}\n`);
  hash.update(await readFile(filePath));
}

/**
 * 枚举本地开发态缺失的必需资产（REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS，含上游
 * 3.16.2 新增的 bundled-skills 动态工作流技能）。是否落回生产资产由调用方按类别决定：
 * 插件 dev 资产多为 .gitignore 的构建产物，缺失可自愈；bundled-skills 是随仓库提交的源文件，
 * 缺失说明检出或打包不完整，保持上游的硬失败。
 */
export function findMissingDevelopmentOfficialPluginAssetPaths(repoRoot: string): string[] {
  const missing: string[] = [];
  for (const requiredRelativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    const absolutePath = join(
      repoRoot,
      "apps",
      "zcode-cli",
      "packages",
      ...requiredRelativePath.split("/"),
    );
    if (!existsSync(absolutePath)) {
      missing.push(requiredRelativePath);
    }
  }
  return missing;
}

async function assertDevelopmentOfficialPluginRequiredAssets(
  packageRoot: string,
  packageName: string,
): Promise<void> {
  const packagePrefix = `${packageName}/`;
  for (const requiredRelativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    if (!requiredRelativePath.startsWith(packagePrefix)) continue;
    const localRelativePath = requiredRelativePath.slice(packagePrefix.length);
    const requiredPath = join(packageRoot, ...localRelativePath.split("/"));
    try {
      await access(requiredPath);
    } catch {
      throw new Error(
        `[zcode-agent-deploy] missing official plugin required asset: ${requiredPath}`,
      );
    }
  }
}

async function findMissingRemoteOfficialPluginAssetPaths(params: {
  backend: IRemoteBackend;
  remoteProviderDir: string;
}): Promise<string[]> {
  const requiredPaths = buildRemoteAgentOfficialPluginRequiredPaths(params.remoteProviderDir);
  // 批量探测：一次远端往返替代逐文件 exists（此前约 60 次串行 wsl.exe 往返）。
  const exists = await remoteExistsMany(params.backend, requiredPaths);
  return requiredPaths.filter((_, index) => !exists[index]);
}

async function shouldSkipDevelopmentZCodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteVersionFile: string;
  remoteDevVersionFile: string;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  runtimeVersion: string;
  devVersion: string;
  localBundleSha256: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  let remoteVersion: string;
  let remoteDevVersion: string;
  try {
    remoteVersion = (await params.backend.readFile(params.remoteVersionFile)).trim();
    remoteDevVersion = (await params.backend.readFile(params.remoteDevVersionFile)).trim();
  } catch {
    return false;
  }

  if (remoteVersion !== params.runtimeVersion || remoteDevVersion !== params.devVersion) {
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (!(await params.backend.exists(params.remoteBundlePath))) {
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    return false;
  }

  // 旧发布包或另一客户端可能覆盖 bundle，却留下相同的 .dev-version。
  // 标记只描述上次部署意图；跳过上传前必须在远端校验实际文件，避免 PAT 交给旧版 Agent 的过时鉴权逻辑。
  const verifyBundleScript =
    "require('node:fs/promises').readFile(process.argv[1]).then(content => {" +
    "process.exitCode = require('node:crypto').createHash('sha256').update(content).digest('hex') === process.argv[2] ? 0 : 1;" +
    "}).catch(() => { process.exitCode = 1; });";
  try {
    await waitForClose(
      await params.backend.exec(
        `"\${ZCODE_SERVER_RUNTIME_ROOT:-$HOME/.zcode/server}/node" -e ${quotePosixShellArg(verifyBundleScript)} ${quotePosixPathArg(params.remoteBundlePath)} ${quotePosixShellArg(params.localBundleSha256)}`,
      ),
    );
  } catch {
    params.loggers.logWarn(
      `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 远端 bundle SHA 不匹配或无法校验，重新上传`,
    );
    return false;
  }

  params.loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态 zcode.cjs 未变化，跳过`);
  return true;
}

async function stageDevelopmentOfficialPluginPackages(params: {
  repoRoot: string;
  packagesDir: string;
}): Promise<void> {
  await mkdir(params.packagesDir, { recursive: true });
  for (const packageName of REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES) {
    const sourceRoot = join(params.repoRoot, "apps", "zcode-cli", "packages", packageName);
    const manifestPath = join(sourceRoot, ".zcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[zcode-agent-deploy] missing official plugin manifest: ${manifestPath}`);
    }
    await assertDevelopmentOfficialPluginRequiredAssets(sourceRoot, packageName);

    const targetRoot = join(params.packagesDir, packageName);
    await mkdir(targetRoot, { recursive: true });
    for (const topLevelPath of REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS) {
      const sourcePath = join(sourceRoot, topLevelPath);
      if (existsSync(sourcePath)) {
        await cp(sourcePath, join(targetRoot, topLevelPath), {
          recursive: true,
        });
      }
    }
  }
  // 修复原因：内置技能不再是插件，单独复制完整包，不能要求 plugin.json 或按插件白名单裁剪。
  const bundledSkillsRoot = join(params.repoRoot, "apps/zcode-cli/packages/bundled-skills");
  // 与 hash 阶段同口径：随仓库提交的源文件缺失时硬失败（不参与插件构建产物的落回）。
  await assertDevelopmentOfficialPluginRequiredAssets(bundledSkillsRoot, "bundled-skills");
  await cp(bundledSkillsRoot, join(params.packagesDir, "bundled-skills"), { recursive: true });
}

async function uploadDevelopmentOfficialPluginPackages(params: {
  backend: IRemoteBackend;
  repoRoot: string;
  remoteProviderDir: string;
  loggers: DeployLoggers;
}): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-remote-agent-packages-"));
  const packagesDir = join(tempDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
  const archivePath = join(tempDir, `${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz`);
  try {
    await stageDevelopmentOfficialPluginPackages({
      repoRoot: params.repoRoot,
      packagesDir,
    });
    await createTarGzArchive(archivePath, [
      {
        sourcePath: packagesDir,
        archivePath: REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
      },
    ]);

    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // 开发态官方插件曾使用固定 packages.tar.gz；多个部署 owner 会覆盖彼此的上传。
    // archive/extract 使用同一 owner 后缀，失败清理不会误删其他部署者的文件。
    const remoteArchivePath = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.tar.gz-${ownerSuffix}`;
    const remoteExtractDir = `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}.extract-${ownerSuffix}`;
    const extractedPackagesDir = `${remoteExtractDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`;
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await params.backend.exec(
          `rm -f ${quotePosixPathArg(remoteArchivePath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        params.loggers.logWarn(
          `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 清理 owner staging 失败 (${ownerSuffix}): ${String(error)}`,
        );
      }
    };
    params.loggers.log(`[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态上传官方插件资源`);
    try {
      await params.backend.upload(archivePath, remoteArchivePath);
      await repairLegacyRemoteOfficialPluginDirectoryPermissions({
        backend: params.backend,
        loggers: params.loggers,
        remoteOfficialPluginDir: buildRemoteAgentOfficialPluginDir(params.remoteProviderDir),
      });
      const stream = await params.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteArchivePath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(params.remoteProviderDir)}`,
          `tar -xzf ${quotePosixPathArg(remoteArchivePath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedPackagesDir)}`,
          `rm -rf ${quotePosixPathArg(`${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`)}`,
          buildRemoteMoveCommand(
            extractedPackagesDir,
            `${params.remoteProviderDir}/${REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME}`,
          ),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      await cleanupRemoteStaging();
      throw error;
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function deployDevelopmentZCodeAgentRuntime(
  backend: IRemoteBackend,
  params: DeployDevelopmentZCodeAgentRuntimeParams,
  loggers: DeployLoggers,
): Promise<boolean> {
  const developmentBundle = resolveDevelopmentAgentBundle();
  if (!developmentBundle) {
    return false;
  }

  const remoteBundlePath = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_BUNDLE_NAME}`;
  const remoteDevVersionFile = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_VERSION_FILE_NAME}`;
  // 开发态官方插件依赖 .gitignore 的构建产物（如 browser-use-plugin/scripts/browser-client.mjs）。
  // 未打包运行或 fresh clone 时这些 dev 资产常缺：dev 部署不能整体硬失败，否则 prepare 报
  // generic「preparation failed」。这里探测必需资产，缺失时 logWarn 并返回 false，让调用方
  // 落回标准生产资产部署（manifest/components 路径）。
  // bundled-skills 是随仓库提交的源文件（skills/dynamic-workflows/*），缺失不是构建产物问题，
  // 因此不参与落回：交给 computeDevelopmentAgentAssetsSha256 的必需资产断言按上游语义硬失败。
  const missingDevAssetPaths = findMissingDevelopmentOfficialPluginAssetPaths(
    developmentBundle.repoRoot,
  ).filter((relativePath) => !relativePath.startsWith("bundled-skills/"));
  if (missingDevAssetPaths.length > 0) {
    loggers.logWarn(
      `[zcode-agent-deploy] dev: 本地开发态官方插件缺少必需资产，落回标准生产资产部署。` +
        `缺失: ${missingDevAssetPaths.join(", ")}。` +
        `如需 dev 插件资产，请在仓库内运行各官方插件构建（例如 pnpm --filter @zcode/browser-use-plugin build）。`,
    );
    return false;
  }
  const devVersion = await computeDevelopmentAgentAssetsSha256({
    localBundlePath: developmentBundle.localBundlePath,
    repoRoot: developmentBundle.repoRoot,
  });
  let missingOfficialPluginAssetPaths: string[];
  try {
    missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths({
      backend,
      remoteProviderDir: params.remoteProviderDir,
    });
  } catch (error) {
    // 与生产部署同口径：探测瞬时失败按缺失处理并留下原因，触发幂等重部署。
    loggers.logWarn(
      `[zcode-agent-deploy] dev: 远端插件资产探测失败，按缺失处理并触发重部署: ${String(error)}`,
    );
    missingOfficialPluginAssetPaths = buildRemoteAgentOfficialPluginRequiredPaths(
      params.remoteProviderDir,
    );
  }

  if (
    await shouldSkipDevelopmentZCodeAgentDeploy({
      backend,
      remoteVersionFile: params.remoteVersionFile,
      remoteDevVersionFile,
      remoteBinaryPath: params.remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: params.runtimeResourceDir,
      runtimeVersion: params.runtimeVersion,
      devVersion,
      localBundleSha256: createHash("sha256")
        .update(await readFile(developmentBundle.localBundlePath))
        .digest("hex"),
      force: params.force,
      missingOfficialPluginAssetPaths,
      loggers,
    })
  ) {
    return true;
  }

  // 开发态 SSH 远端过去只会部署本地 zcode.cjs，不会携带 packages/*-plugin。
  // builtin plugin seed 依赖 agent 包旁边的官方插件源资源，所以 dev 部署需要同步 bundle 与插件资源。
  // 本地修改 apps/zcode-cli 后，远端测试仍运行滞后的发布包。这里改为上传 dev 启动时刚构建的
  // dist/zcode.cjs，并用远端已部署的 node 包一层 wrapper 启动，保证 agent 仍运行在目标机器内。
  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态上传本地 zcode.cjs ${devVersion.slice(0, 12)}`,
  );
  const mkdirStream = await backend.exec(`mkdir -p ${quotePosixPathArg(params.remoteProviderDir)}`);
  await waitForClose(mkdirStream);

  const remoteBundleTempPath = `${remoteBundlePath}.new`;
  await backend.upload(developmentBundle.localBundlePath, remoteBundleTempPath);
  const bundleStream = await backend.exec(
    buildRemoteMoveCommand(remoteBundleTempPath, remoteBundlePath),
  );
  await waitForClose(bundleStream);
  await uploadDevelopmentOfficialPluginPackages({
    backend,
    repoRoot: developmentBundle.repoRoot,
    remoteProviderDir: params.remoteProviderDir,
    loggers,
  });

  const wrapperContent = buildRemoteAgentBundleWrapper(params.runtimeResourceDir);
  const markerCommands = [
    buildWriteLiteralFileCommand(remoteDevVersionFile, devVersion),
    buildWriteLiteralFileCommand(params.remoteVersionFile, params.runtimeVersion),
  ];
  let markerStream;
  if (isWslBackend(backend)) {
    await deployRemoteAgentWrapper({
      backend,
      content: wrapperContent,
      remoteWrapperPath: params.remoteBinaryPath,
    });
    markerStream = await backend.exec(markerCommands.join(" && "));
  } else {
    const remoteWrapperTempPath = `${params.remoteBinaryPath}.new`;
    markerStream = await backend.exec(
      [
        buildWriteLiteralFileCommand(remoteWrapperTempPath, wrapperContent),
        buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteBinaryPath),
        ...markerCommands,
      ].join(" && "),
    );
  }
  await waitForClose(markerStream);
  loggers.log(
    `[zcode-agent-deploy] ${ZCODE_AGENT_PROVIDER}: 开发态部署完成 ${devVersion.slice(0, 12)}`,
  );
  return true;
}
