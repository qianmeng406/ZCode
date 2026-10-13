import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "@zcode/rpc";
import type { ConnectOptions } from "../src/remote/connect.js";
import {
  buildRemoteRuntimeEnvPrefix,
  buildRemoteServerCommand,
  pickRemoteRuntimeEnv,
} from "../src/remote/server-command.js";
import {
  buildResidentBridgeCommand,
  buildResidentDaemonStartCommand,
  execRemoteCommandAndWait,
} from "../src/remote/resident-connect.js";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";

const baseEnvPrefix =
  'ZCODE_SERVICE_AUTHORITY_MODE="desktop-attached-remote" ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"';

const baseOptions: ConnectOptions = {
  appVersion: "3.14.3",
  remoteRuntimeEnv: { ZCODE_ENV: "production" },
};

test("运行时 env 白名单：只透传声明的键，空白值剔除", () => {
  const env = pickRemoteRuntimeEnv({
    ZCODE_ENV: "production",
    SECRET_KEY: "should-not-leak",
    ZCODE_BASE_URL: "   ",
    ZAI_OAUTH_CLIENT_ID: "client-id",
  });
  assert.deepEqual(env, { ZCODE_ENV: "production", ZAI_OAUTH_CLIENT_ID: "client-id" });
});

test("resident start 命令：复用 stdio 的运行时 env 前缀并追加 --resident-start", () => {
  const envPrefix = buildRemoteRuntimeEnvPrefix(baseOptions, undefined);
  // env 前缀与 stdio 命令同一来源（I5：stdio 行为零变化的回归锚点）。
  assert.match(envPrefix, /ZCODE_SERVICE_AUTHORITY_MODE="desktop-attached-remote"/);
  assert.match(envPrefix, /ZCODE_SERVER_RUNTIME_ROOT="\$HOME\/\.zcode\/server"/);
  assert.match(envPrefix, /ZCODE_ENV='production'/);
  assert.match(envPrefix, /ZCODE_APP_VERSION='3\.14\.3'/);

  // stdio 命令 = 同一 env 前缀 + 入口（无常驻参数）。
  assert.equal(
    buildRemoteServerCommand(envPrefix),
    `${envPrefix} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`,
  );

  const command = buildResidentDaemonStartCommand(envPrefix);
  assert.match(command, /--resident-start$/);
  assert.match(command, /~\/\.zcode\/server\/zcode-server\.cjs/);
});

test("resident bridge 命令：不携带 env 前缀（bridge 不创建 services）", () => {
  assert.equal(
    buildResidentBridgeCommand(),
    "~/.zcode/server/node ~/.zcode/server/zcode-server.cjs --resident-bridge",
  );
});

interface FakeRemoteStream {
  stream: StdioStream;
  close: (code: number) => void;
  writeStderr: (text: string) => void;
}

function createFakeStdioStream(): FakeRemoteStream {
  const onClose = new Emitter<number>();
  let stderrListener: ((chunk: Buffer) => void) | undefined;
  return {
    stream: {
      stdin: { write: () => undefined } as unknown as NodeJS.WritableStream,
      stdout: { on: () => undefined } as unknown as NodeJS.ReadableStream,
      stderr: {
        on: (_event: string, listener: (chunk: Buffer) => void) => {
          stderrListener = listener;
        },
      } as unknown as NodeJS.ReadableStream,
      onClose: onClose.event,
    },
    close: (code) => onClose.fire(code),
    writeStderr: (text) => stderrListener?.(Buffer.from(text)),
  };
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

test("execRemoteCommandAndWait：退出码 0 正常返回，非 0 携带 stderr 尾部", async () => {
  const executed: string[] = [];
  const streams: FakeRemoteStream[] = [];
  const backend = {
    exec: async (command: string) => {
      executed.push(command);
      const fake = createFakeStdioStream();
      streams.push(fake);
      return fake.stream;
    },
  } as IRemoteBackend;

  const success = execRemoteCommandAndWait(backend, "ok-command");
  // backend.exec 是异步解析的：先让 promise body 挂上 onClose 监听再触发关闭。
  await flushAsync();
  streams[0]?.close(0);
  await assert.doesNotReject(success);

  const failing = execRemoteCommandAndWait(backend, "fail-command");
  await flushAsync();
  streams[1]?.writeStderr("boom: daemon crashed");
  streams[1]?.close(1);
  await assert.rejects(failing, /code 1.*boom: daemon crashed/s);
  assert.deepEqual(executed, ["ok-command", "fail-command"]);
});

test("execRemoteCommandAndWait：超时按失败收口", async () => {
  const fake = createFakeStdioStream();
  const backend = { exec: async () => fake.stream } as IRemoteBackend;
  await assert.rejects(
    execRemoteCommandAndWait(backend, "hang", { timeoutMs: 30 }),
    /timed out after 30ms/,
  );
  await flushAsync();
  fake.close(0);
});
