import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { runResidentStdioBridge } from "../src/remote/resident-bridge.js";
import { writeResidentDaemonStatus } from "../src/remote/resident-protocol.js";

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-resident-bridge-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

interface LoopbackPair {
  client: net.Socket;
  server: net.Socket;
  close: () => void;
}

/** 真实回环 socket 对：双向字节语义与远端 TCP 完全一致，避免假双工的自环。 */
function createLoopbackSocketPair(): Promise<LoopbackPair> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    let client: net.Socket | undefined;
    let server: net.Socket | undefined;
    const finish = () => {
      if (client && server) {
        resolve({
          client,
          server,
          close: () => {
            client.destroy();
            server.destroy();
            srv.close();
          },
        });
      }
    };
    srv.on("connection", (socket) => {
      server = socket;
      finish();
    });
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      client = net.connect(port, "127.0.0.1");
      client.once("connect", finish);
      client.once("error", reject);
    });
  });
}

function createBridgeIo() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
  return {
    io: { stdin, stdout, stderr },
    stdin,
    stdoutChunks,
    stderrChunks,
  };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor: condition not met within timeout");
};

test("bridge：读 daemon.json 端口，双向字节透传与双向终止", async () => {
  await withTempRoot(async (root) => {
    await writeResidentDaemonStatus(`${root}/daemon.json`, {
      pid: process.pid,
      port: 45678,
      version: "3.14.3",
      startedAt: 1,
    });
    const pair = await createLoopbackSocketPair();
    try {
      const { io, stdin, stdoutChunks, stderrChunks } = createBridgeIo();
      const serverChunks: string[] = [];
      pair.server.on("data", (chunk: Buffer) => serverChunks.push(chunk.toString("utf8")));

      const exitPromise = runResidentStdioBridge({
        runtimeRoot: root,
        io,
        connect: async () => pair.client,
      });

      // stdin → daemon 方向。
      stdin.write("desktop rpc frame");
      await waitFor(() => serverChunks.includes("desktop rpc frame"));
      assert.equal(serverChunks.join(""), "desktop rpc frame");

      // daemon → stdout 方向（daemon 的 per-connection hello 行走同一管道）。
      pair.server.write('{"type":"zcode-hello"}\n');
      await waitFor(() => stdoutChunks.length > 0);
      assert.equal(stdoutChunks.join(""), '{"type":"zcode-hello"}\n');

      // 桌面 dispose：stdin EOF → 半关 TCP（daemon 侧走 scope 退订）。
      stdin.end();
      await waitFor(() => pair.server.writableEnded);
      assert.equal(stderrChunks.join(""), "");

      // daemon 侧关闭 → bridge 以 0 退出（stdout 已 end）。
      pair.server.end();
      assert.equal(await exitPromise, 0);
    } finally {
      pair.close();
    }
  });
});

test("bridge：daemon.json 缺失 → 退出 1 并写 stderr 诊断", async () => {
  await withTempRoot(async (root) => {
    const { io, stderrChunks } = createBridgeIo();
    const code = await runResidentStdioBridge({ runtimeRoot: root, io });
    assert.equal(code, 1);
    assert.match(stderrChunks.join(""), /daemon\.json not found/);
  });
});

test("bridge：连接失败 → 退出 1 并携带端口诊断", async () => {
  await withTempRoot(async (root) => {
    await writeResidentDaemonStatus(`${root}/daemon.json`, {
      pid: process.pid,
      port: 45678,
      version: "3.14.3",
      startedAt: 1,
    });
    const { io, stderrChunks } = createBridgeIo();
    const code = await runResidentStdioBridge({
      runtimeRoot: root,
      io,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(code, 1);
    assert.match(stderrChunks.join(""), /connect to 127\.0\.0\.1:45678 failed: ECONNREFUSED/);
  });
});
