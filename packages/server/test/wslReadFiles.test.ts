import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ access: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: io.access,
  readFile: io.readFile,
}));

import { WSLBackend } from "../src/remote/wsl-backend.js";

type BackendProbe = {
  ensureAvailable(): Promise<void>;
  resolveInfo(): Promise<{ distroName: string; userName: string; homeDir: string; version: 2 }>;
  execSimple(command: string): Promise<string>;
};

function fixture() {
  const backend = new WSLBackend({ kind: "wsl", distro: "Ubuntu-24.04", user: "tester" });
  const probe = backend as unknown as BackendProbe;
  const available = vi.spyOn(probe, "ensureAvailable").mockResolvedValue();
  vi.spyOn(probe, "resolveInfo").mockResolvedValue({
    distroName: "Ubuntu-24.04",
    userName: "tester",
    homeDir: "/home/tester",
    version: 2,
  });
  const exec = vi.spyOn(probe, "execSimple");
  return { backend, available, exec };
}

beforeEach(() => {
  io.access.mockReset().mockRejectedValue(new Error("UNC unavailable"));
  io.readFile.mockReset();
});

describe("WSLBackend.readFiles", () => {
  it("空输入无 IO，可用性失败直接传播", async () => {
    const { backend, available, exec } = fixture();
    expect(await backend.readFiles([])).toEqual([]);
    expect(available).not.toHaveBeenCalled();
    available.mockRejectedValue(new Error("unavailable"));
    await expect(backend.readFiles(["/x"])).rejects.toThrow("unavailable");
    expect(exec).not.toHaveBeenCalled();
  });

  it("UNC 内容不规范化，读取失败为 null 且不走 shell", async () => {
    const { backend, exec } = fixture();
    io.access.mockResolvedValue(undefined);
    io.readFile
      .mockResolvedValueOnce("\uFEFFa\r\nb\u0000")
      .mockRejectedValueOnce(new Error("unreadable"));
    expect(await backend.readFiles(["~/one", "~/two"])).toEqual(["\uFEFFa\r\nb\u0000", null]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("shell 路径一次执行，保留空文本和末尾换行，按单项规则规范化文本", async () => {
    const { backend, exec } = fixture();
    exec.mockResolvedValue(`Y:${Buffer.from("\uFEFFa\r\nb\n").toString("base64")}\nY:\nN\n`);
    const single = vi.spyOn(backend, "readFile");
    expect(await backend.readFiles(["~/one", "~/empty", "~/missing"])).toEqual([
      "a\nb\n",
      "",
      null,
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
  });

  it.each(["T\n", "Y:truncated\n", "Y:\nY:\nY:\n"])(
    "异常输出 %s 逐项退化，单项失败不阻断其他",
    async (output) => {
      const { backend, exec } = fixture();
      exec.mockResolvedValue(output);
      const single = vi
        .spyOn(backend, "readFile")
        .mockResolvedValueOnce("ok")
        .mockRejectedValueOnce(new Error("missing"));
      expect(await backend.readFiles(["~/one", "~/two"])).toEqual(["ok", null]);
      expect(single.mock.calls).toEqual([["~/one"], ["~/two"]]);
    },
  );

  it("UNC 命中项不因其他 shell 输出失败而重复读取", async () => {
    const { backend, exec } = fixture();
    io.access.mockImplementation(async (path: string) => {
      if (path.includes("one")) return;
      throw new Error("no UNC");
    });
    io.readFile.mockResolvedValue("original\r\n");
    exec.mockRejectedValue(new Error("command failed"));
    const single = vi.spyOn(backend, "readFile").mockResolvedValue("fallback");
    expect(await backend.readFiles(["~/one", "~/two"])).toEqual(["original\r\n", "fallback"]);
    expect(single).toHaveBeenCalledExactlyOnceWith("~/two");
  });
});
