import { describe, expect, it, vi } from "vitest";
import { connectSessionLinux } from "../src/host/sessionLinuxConnection.js";

const target = { kind: "wsl", distro: "Ubuntu-test", user: "isolated" } as const;

function fixture() {
  const backend = { dispose: vi.fn() };
  const connection = { client: {}, dispose: vi.fn(), disposeAndWait: vi.fn(), resident: false };
  const createRemoteBackend = vi.fn().mockResolvedValue(backend);
  const connectRemote = vi.fn().mockResolvedValue(connection);
  const loadRemote = vi.fn().mockResolvedValue({ createRemoteBackend, connectRemote });
  return { backend, connection, createRemoteBackend, connectRemote, loadRemote };
}

describe("session Linux connection", () => {
  it("deploys through standard stdio with explicit assets and resident disabled", async () => {
    const f = fixture();
    const onProgress = vi.fn();
    const onClose = vi.fn();
    const assets = { mockCdnDir: "C:/isolated/assets", remoteCacheDir: "C:/isolated/cache" };
    const signal = new AbortController().signal;
    const result = await connectSessionLinux(target, { assets, signal, onProgress, onClose }, f);
    expect(result).toBe(f.connection);
    expect(f.createRemoteBackend).toHaveBeenCalledWith(target);
    expect(f.connectRemote).toHaveBeenCalledWith(
      f.backend,
      expect.objectContaining({
        ...assets,
        signal,
        resident: false,
        appVersion: expect.any(String),
      }),
    );
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "checking",
      "deploying",
      "handshaked",
    ]);
    const options = f.connectRemote.mock.calls[0]![1];
    options.onDidRemoteClose({ code: 1 });
    options.onDidRemoteClose({ code: -1 });
    expect(onClose).toHaveBeenCalledOnce();
    expect(options.remoteRuntimeEnv).toBeUndefined();
  });

  it("rejects unavailable assets before loading or spawning any backend", async () => {
    const f = fixture();
    await expect(connectSessionLinux(target, { assets: {} }, f)).rejects.toThrow(
      "assets unavailable",
    );
    expect(f.loadRemote).not.toHaveBeenCalled();
  });

  it("does not create a backend for cancelled preparation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("preparation cancelled"));
    await expect(
      connectSessionLinux(
        target,
        {
          assets: { mockCdnDir: "C:/isolated/assets" },
          signal: controller.signal,
        },
        f,
      ),
    ).rejects.toThrow("preparation cancelled");
    expect(f.createRemoteBackend).not.toHaveBeenCalled();
  });

  it("disposes a connection that closes before it is published", async () => {
    const f = fixture();
    f.connectRemote.mockImplementation(async (_backend, options) => {
      options.onDidRemoteClose({ code: -1 });
      return f.connection;
    });
    await expect(
      connectSessionLinux(
        target,
        {
          assets: { mockCdnDir: "C:/isolated/assets" },
        },
        f,
      ),
    ).rejects.toThrow("closed during preparation");
    expect(f.connection.disposeAndWait).toHaveBeenCalledOnce();
  });

  it("disposes a late successful connection after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.connectRemote.mockImplementation(async () => {
      controller.abort(new Error("cancelled during handshake"));
      return f.connection;
    });
    await expect(
      connectSessionLinux(
        target,
        {
          assets: { mockCdnDir: "C:/isolated/assets" },
          signal: controller.signal,
        },
        f,
      ),
    ).rejects.toThrow("cancelled during handshake");
    expect(f.connection.disposeAndWait).toHaveBeenCalledOnce();
  });

  it("checks cancellation again after lazy runtime import", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.loadRemote.mockImplementation(async () => {
      controller.abort(new Error("cancelled during import"));
      return { createRemoteBackend: f.createRemoteBackend, connectRemote: f.connectRemote };
    });
    await expect(
      connectSessionLinux(
        target,
        {
          assets: { mockCdnDir: "C:/isolated/assets" },
          signal: controller.signal,
        },
        f,
      ),
    ).rejects.toThrow("cancelled during import");
    expect(f.createRemoteBackend).not.toHaveBeenCalled();
  });
});
