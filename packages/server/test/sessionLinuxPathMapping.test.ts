import { describe, expect, it } from "vitest";
import {
  isLinuxCwdWithinWorkspace,
  mapWorkspacePaths,
  verifySameFileOnWindows,
  windowsPathsEquivalent,
} from "../src/sessionLinuxExecution/pathMapping.js";

describe("mapWorkspacePaths (Linux 侧 wslpath→realpath→wslpath roundtrip)", () => {
  it("performs wslpath -u, realpath, wslpath -w in order and returns mapped paths", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const mapped = await mapWorkspacePaths(
      {
        execLinux: async (command, args) => {
          calls.push({ command, args });
          if (command === "wslpath" && args[0] === "-u") return "/mnt/c/proj\n";
          if (command === "realpath") return "/mnt/c/proj";
          if (command === "wslpath" && args[0] === "-w") return "C:\\proj";
          throw new Error("unexpected call");
        },
        existsDirLinux: async () => true,
      },
      "C:\\proj",
    );
    expect(calls.map((call) => call.command)).toEqual(["wslpath", "realpath", "wslpath"]);
    expect(calls[0].args).toEqual(["-u", "C:\\proj"]);
    expect(calls[2].args).toEqual(["-w", "/mnt/c/proj"]);
    expect(mapped).toEqual({
      originalWindowsPath: "C:\\proj",
      linuxPath: "/mnt/c/proj",
      mappedWindowsPath: "C:\\proj",
    });
  });

  it("fails closed with path_unmappable when wslpath -u fails or is empty", async () => {
    await expect(
      mapWorkspacePaths({ execLinux: async () => "" }, "C:\\missing"),
    ).rejects.toMatchObject({ name: "PathMappingError", code: "path_unmappable" });
    await expect(
      mapWorkspacePaths(
        {
          execLinux: async (command) => {
            if (command === "wslpath") throw new Error("wslpath: no such file");
            return "";
          },
        },
        "C:\\missing",
      ),
    ).rejects.toMatchObject({ code: "path_unmappable" });
  });

  it("fails with path_not_found when realpath fails", async () => {
    await expect(
      mapWorkspacePaths(
        {
          execLinux: async (command) => {
            if (command === "wslpath") return "/mnt/c/gone";
            throw new Error("realpath: No such file or directory");
          },
        },
        "C:\\gone",
      ),
    ).rejects.toMatchObject({ code: "path_not_found" });
  });

  it("fails with path_not_directory when the resolved path is not an existing directory", async () => {
    await expect(
      mapWorkspacePaths(
        {
          execLinux: async (command) =>
            command === "wslpath" ? "/mnt/c/file.txt" : "/mnt/c/file.txt",
          existsDirLinux: async () => false,
        },
        "C:\\file.txt",
      ),
    ).rejects.toMatchObject({ code: "path_not_directory" });
  });

  it("treats existsDirLinux throw as not-a-directory (fail closed)", async () => {
    await expect(
      mapWorkspacePaths(
        {
          execLinux: async () => "/mnt/c/proj",
          existsDirLinux: async () => {
            throw new Error("stat failed");
          },
        },
        "C:\\proj",
      ),
    ).rejects.toMatchObject({ code: "path_not_directory" });
  });
});

describe("windowsPathsEquivalent", () => {
  it("is case-insensitive and separator-insensitive", () => {
    expect(windowsPathsEquivalent("C:\\Proj\\Sub", "c:/proj/sub")).toBe(true);
    expect(windowsPathsEquivalent("C:\\proj\\", "C:\\proj")).toBe(true);
    expect(windowsPathsEquivalent("C:\\proj2", "C:\\proj")).toBe(false);
  });

  it("does not treat a prefix as equal", () => {
    expect(windowsPathsEquivalent("C:\\proj", "C:\\project")).toBe(false);
  });
});

describe("isLinuxCwdWithinWorkspace", () => {
  it("accepts the workspace root and nested paths", () => {
    expect(isLinuxCwdWithinWorkspace("/mnt/c/proj", "/mnt/c/proj")).toBe(true);
    expect(isLinuxCwdWithinWorkspace("/mnt/c/proj/sub/dir", "/mnt/c/proj")).toBe(true);
    expect(isLinuxCwdWithinWorkspace("/mnt/c/proj/", "/mnt/c/proj")).toBe(true);
  });

  it("rejects outside and prefix-collision paths", () => {
    expect(isLinuxCwdWithinWorkspace("/mnt/c/project", "/mnt/c/proj")).toBe(false);
    expect(isLinuxCwdWithinWorkspace("/mnt/c", "/mnt/c/proj")).toBe(false);
    expect(isLinuxCwdWithinWorkspace("/etc", "/mnt/c/proj")).toBe(false);
    expect(isLinuxCwdWithinWorkspace("/mnt/c/proj/../escape", "/mnt/c/proj")).toBe(false);
  });
});

describe("verifySameFileOnWindows (Host 侧 roundtrip 校验)", () => {
  const deps = (original: string, mapped: string) => ({
    realpathNative: async (path: string) => path,
    statIsDirectory: async () => true,
    __expected: { original, mapped },
  });

  it("passes when realpath-normalized paths match case-insensitively", async () => {
    const ok = await verifySameFileOnWindows(deps("C:\\Proj", "C:\\proj"), "C:\\Proj", "c:\\proj");
    expect(ok).toBe(true);
  });

  it("fails when roundtrip path diverges (symlink resolution mismatch)", async () => {
    const d = {
      realpathNative: async (path: string) =>
        path.startsWith("C:\\proj") ? "C:\\real\\proj" : path,
      statIsDirectory: async () => true,
    };
    const ok = await verifySameFileOnWindows(d, "C:\\proj", "C:\\other");
    expect(ok).toBe(false);
  });

  it("fails when stat says it is not a directory", async () => {
    const ok = await verifySameFileOnWindows(
      {
        realpathNative: async (path) => path,
        statIsDirectory: async () => false,
      },
      "C:\\proj",
      "C:\\proj",
    );
    expect(ok).toBe(false);
  });

  it("fails closed when realpath throws", async () => {
    const ok = await verifySameFileOnWindows(
      {
        realpathNative: async () => {
          throw new Error("EPERM");
        },
        statIsDirectory: async () => true,
      },
      "C:\\proj",
      "C:\\proj",
    );
    expect(ok).toBe(false);
  });
});
