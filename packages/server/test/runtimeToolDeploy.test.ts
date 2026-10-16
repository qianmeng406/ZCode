import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { getRemoteRuntimeToolsForPlatform } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { deployRuntimeTools } from "../src/remote/runtimeToolDeploy.js";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";

const tools = getRemoteRuntimeToolsForPlatform("linux");
const versionPaths = tools.map(
  ({ runtime }) => `~/.zcode/server/tools/${runtime.bundledResourceDir}/.version`,
);
const binaryPaths = tools.map(
  ({ runtime }) =>
    `~/.zcode/server/tools/${runtime.bundledResourceDir}/${runtime.resolveEntrySegments("linux").at(-1)}`,
);

function closedStream(code = 0): StdioStream {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    onClose: (listener) => {
      queueMicrotask(() => listener(code));
      return { dispose() {} };
    },
  };
}

function fixture() {
  const backend: IRemoteBackend = {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => undefined,
    dispose() {},
    exec: vi.fn(async () => closedStream()),
    readFile: vi.fn(async () => {
      throw new Error("single read unexpected");
    }),
    exists: vi.fn(async () => {
      throw new Error("single exists unexpected");
    }),
    readFiles: vi.fn(async () => tools.map(({ version }) => `${version}\n`)),
    existsMany: vi.fn(async (paths) => paths.map(() => true)),
  };
  const installer: RemoteAssetInstaller = {
    mode: "local-download-upload",
    installFile: vi.fn(async () => undefined),
    installDirectory: vi.fn(async () => undefined),
  };
  const options = { platformArch: "linux-x64", installer };
  const loggers = { log: vi.fn(), logWarn: vi.fn() };
  const run = () =>
    deployRuntimeTools(backend, { platform: "linux", arch: "x64" }, options, loggers);
  return { backend, installer, options, run };
}

describe("deployRuntimeTools batch checks", () => {
  it("三个工具全命中时仅一次批量读和一次批量探测，不安装", async () => {
    const { backend, installer, run } = fixture();
    await run();
    expect(backend.readFiles).toHaveBeenCalledExactlyOnceWith(versionPaths);
    expect(backend.existsMany).toHaveBeenCalledExactlyOnceWith(binaryPaths);
    expect(installer.installFile).not.toHaveBeenCalled();
    expect(backend.exec).not.toHaveBeenCalled();
    expect(backend.readFile).not.toHaveBeenCalled();
    expect(backend.exists).not.toHaveBeenCalled();
  });

  it("读失败、版本过期和 binary 缺失仍按原工具顺序安装并写版本", async () => {
    const { backend, installer, run } = fixture();
    backend.readFiles = vi.fn(async () => [null, "old", tools[2]!.version]);
    backend.existsMany = vi.fn(async () => [false]);
    await run();
    expect(backend.existsMany).toHaveBeenCalledExactlyOnceWith([binaryPaths[2]]);
    expect(
      vi.mocked(installer.installFile).mock.calls.map(([params]) => params.remotePath),
    ).toEqual(binaryPaths);
    expect(backend.exec).toHaveBeenCalledTimes(3);
    for (let index = 0; index < tools.length; index += 1) {
      expect(vi.mocked(backend.exec).mock.calls[index]![0]).toContain(tools[index]!.version);
      expect(vi.mocked(installer.installFile).mock.invocationCallOrder[index]).toBeLessThan(
        vi.mocked(backend.exec).mock.invocationCallOrder[index]!,
      );
    }
  });

  it("单个版本读取失败不影响其他工具命中，且不探测失败项的 binary", async () => {
    const { backend, installer, run } = fixture();
    delete backend.readFiles;
    backend.readFile = vi.fn(async (path) => {
      if (path === versionPaths[0]) throw new Error("unreadable");
      return tools[versionPaths.indexOf(path)]!.version;
    });
    await run();
    expect(backend.existsMany).toHaveBeenCalledExactlyOnceWith(binaryPaths.slice(1));
    expect(installer.installFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installer.installFile).mock.calls[0]![0].remotePath).toBe(binaryPaths[0]);
  });

  it("未选择任何资源时无远端 IO", async () => {
    const { backend, installer, options, run } = fixture();
    Object.assign(options, { selectedResourcePackageIds: [] });
    await run();
    expect(backend.readFiles).not.toHaveBeenCalled();
    expect(backend.existsMany).not.toHaveBeenCalled();
    expect(installer.installFile).not.toHaveBeenCalled();
  });

  it("只预取选中的工具，未选资源无读取和探测", async () => {
    const { backend, options, run } = fixture();
    Object.assign(options, { selectedResourcePackageIds: ["ripgrep"] });
    backend.readFiles = vi.fn(async () => [tools[1]!.version]);
    await run();
    expect(backend.readFiles).toHaveBeenCalledExactlyOnceWith([versionPaths[1]]);
    expect(backend.existsMany).toHaveBeenCalledExactlyOnceWith([binaryPaths[1]]);
  });

  it("无批量能力的 backend 仍可逐项读取、探测并全部跳过", async () => {
    const { backend, installer, run } = fixture();
    delete backend.readFiles;
    delete backend.existsMany;
    backend.readFile = vi.fn(async (path) => tools[versionPaths.indexOf(path)]!.version);
    backend.exists = vi.fn(async () => true);
    await run();
    expect(vi.mocked(backend.readFile).mock.calls.map(([path]) => path)).toEqual(versionPaths);
    expect(vi.mocked(backend.exists).mock.calls.map(([path]) => path)).toEqual(binaryPaths);
    expect(installer.installFile).not.toHaveBeenCalled();
  });

  it("Darwin 仍只核对其平台支持的 ripgrep", async () => {
    const { backend, installer, options } = fixture();
    const darwinTools = getRemoteRuntimeToolsForPlatform("darwin");
    backend.readFiles = vi.fn(async () => darwinTools.map(({ version }) => version));
    await deployRuntimeTools(
      backend,
      { platform: "darwin", arch: "arm64" },
      { ...options, platformArch: "darwin-arm64" },
      { log() {}, logWarn() {} },
    );
    expect(backend.readFiles).toHaveBeenCalledExactlyOnceWith([versionPaths[1]]);
    expect(backend.existsMany).toHaveBeenCalledExactlyOnceWith([binaryPaths[1]]);
    expect(installer.installFile).not.toHaveBeenCalled();
  });

  it("写版本命令失败不得继续安装后续工具", async () => {
    const { backend, installer, run } = fixture();
    backend.readFiles = vi.fn(async () => [null, null, null]);
    backend.exec = vi.fn(async () => closedStream(1));
    await expect(run()).rejects.toThrow("exit code 1");
    expect(installer.installFile).toHaveBeenCalledTimes(1);
    expect(backend.exec).toHaveBeenCalledTimes(1);
  });

  it("安装失败不得写版本，也不得继续安装后续工具", async () => {
    const { backend, installer, run } = fixture();
    backend.readFiles = vi.fn(async () => [null, null, null]);
    installer.installFile = vi.fn(async () => {
      throw new Error("install failed");
    });
    await expect(run()).rejects.toThrow("install failed");
    expect(installer.installFile).toHaveBeenCalledTimes(1);
    expect(backend.exec).not.toHaveBeenCalled();
  });
});
