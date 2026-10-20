import { describe, expect, it } from "vitest";
import {
  normalizeSessionExecutionEnvironment,
  parseSessionExecutionEnvironment,
  sessionExecutionEnvironmentSchema,
  sessionExecutionStateSchema,
  type SessionExecutionEnvironment,
} from "../src/sessionExecutionEnvironment.js";
import {
  executionWireRequestSchema,
  executionWireResultSchema,
} from "../src/sessionExecutionWire.js";
import {
  sessionExecutionBashBackgroundLifecycleParamsSchema,
  sessionExecutionPrepareParamsSchema,
  sessionExecutionPollResultSchema,
} from "../src/sessionExecutionOperations.js";

describe("sessionExecutionEnvironment", () => {
  it("解析 local/wsl 与缺省行为", () => {
    expect(parseSessionExecutionEnvironment({ kind: "local" })).toEqual({ kind: "local" });
    expect(
      parseSessionExecutionEnvironment({ kind: "wsl", distro: "Ubuntu-22.04", user: "me" }),
    ).toEqual({ kind: "wsl", distro: "Ubuntu-22.04", user: "me" });
    // user 缺省/留空 = 使用发行版默认用户：合法且归一为无 user 字段。
    expect(parseSessionExecutionEnvironment({ kind: "wsl", distro: "Ubuntu-22.04" })).toEqual({
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(
      parseSessionExecutionEnvironment({ kind: "wsl", distro: "Ubuntu-22.04", user: "  " }),
    ).toEqual({ kind: "wsl", distro: "Ubuntu-22.04" });
    // 未指定环境保留现有行为
    expect(parseSessionExecutionEnvironment(undefined)).toBeUndefined();
    expect(parseSessionExecutionEnvironment({})).toBeUndefined();
    // wsl 仍必须显式选择 distro
    expect(parseSessionExecutionEnvironment({ kind: "wsl" })).toBeUndefined();
    expect(parseSessionExecutionEnvironment("wsl")).toBeUndefined();
  });

  it("拒绝非法 wsl user（分隔符/控制字符）", () => {
    expect(
      sessionExecutionEnvironmentSchema.safeParse({ kind: "wsl", distro: "d", user: "a/b" })
        .success,
    ).toBe(false);
    expect(
      sessionExecutionEnvironmentSchema.safeParse({ kind: "wsl", distro: "d", user: "a:b" })
        .success,
    ).toBe(false);
  });

  it("normalize 把 local/undefined 归一为未配置", () => {
    expect(normalizeSessionExecutionEnvironment(undefined)).toBeUndefined();
    const local: SessionExecutionEnvironment = { kind: "local" };
    expect(normalizeSessionExecutionEnvironment(local)).toBeUndefined();
    expect(normalizeSessionExecutionEnvironment({ kind: "wsl", distro: "d", user: "u" })).toEqual({
      kind: "wsl",
      distro: "d",
      user: "u",
    });
    // 空 user 归一到缺省，避免持久层出现 `user: ""` 与字段缺失两种等价形态。
    expect(normalizeSessionExecutionEnvironment({ kind: "wsl", distro: "d", user: "" })).toEqual({
      kind: "wsl",
      distro: "d",
    });
  });

  it("state schema 区分 idle/preparing", () => {
    const idle = { status: "idle", environment: { kind: "local" } };
    expect(sessionExecutionStateSchema.safeParse(idle).success).toBe(true);
    const preparing = {
      status: "preparing",
      current: { kind: "local" },
      target: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
    };
    expect(sessionExecutionStateSchema.safeParse(preparing).success).toBe(true);
    expect(sessionExecutionStateSchema.safeParse({ status: "failed" }).success).toBe(false);
  });
});

describe("sessionExecutionWire", () => {
  it("prepare 参数严格校验，多余字段拒绝", () => {
    const ok = {
      operation: "prepare",
      sessionId: "s1",
      environment: { kind: "wsl", distro: "Ubuntu-22.04", user: "me" },
      workspacePath: "C:\\proj",
    };
    expect(sessionExecutionPrepareParamsSchema.safeParse(ok).success).toBe(true);
    // 留空 user（缺省字段）同样合法：由执行端使用发行版默认用户。
    expect(
      sessionExecutionPrepareParamsSchema.safeParse({
        ...ok,
        environment: { kind: "wsl", distro: "Ubuntu-22.04" },
      }).success,
    ).toBe(true);
    expect(sessionExecutionPrepareParamsSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("run 请求 stdin 用 base64/text，时间戳字段均为 *AtMs", () => {
    const request = {
      command: { mode: "argv", file: "/bin/bash", args: ["-c", "echo hi"] },
      cwd: "C:\\proj",
      stdinText: "hello",
      timeoutMs: 1000,
    };
    expect(executionWireRequestSchema.safeParse(request).success).toBe(true);
    // 不允许 Date/Uint8Array 直接进 wire
    expect(
      executionWireRequestSchema.safeParse({ ...request, stdin: new Uint8Array([1]) }).success,
    ).toBe(false);

    const result = {
      status: "completed",
      exitCode: 0,
      stdout: { text: "", bytes: 0, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
      durationMs: 5,
      timedOut: false,
      cancelled: false,
      startedAtMs: 1700000000000,
      completedAtMs: 1700000000005,
    };
    expect(executionWireResultSchema.safeParse(result).success).toBe(true);
    expect(
      executionWireResultSchema.safeParse({
        ...result,
        startedAt: new Date(0),
      }).success,
    ).toBe(false);
  });

  it("poll 结果只携带事件窗口与可选终态", () => {
    expect(
      sessionExecutionPollResultSchema.safeParse({
        events: [
          {
            type: "started",
            pid: 12,
            timestampMs: 1700000000000,
          },
        ],
        nextCursor: 1,
      }).success,
    ).toBe(true);
    expect(
      sessionExecutionPollResultSchema.safeParse({
        events: [{ type: "started", timestamp: new Date() }],
        nextCursor: 1,
      }).success,
    ).toBe(false);
  });

  it("bashBackgroundLifecycle 保留 explicit/auto_on_timeout 两种模式", () => {
    const base = {
      sessionId: "s1",
      lease: { leaseId: "l1", generation: 0 },
      executionId: "e1",
      request: { command: { mode: "shell", command: "sleep 30" } },
    };
    expect(
      sessionExecutionBashBackgroundLifecycleParamsSchema.safeParse({
        operation: "bashBackgroundLifecycle",
        ...base,
        mode: "explicit",
      }).success,
    ).toBe(true);
    expect(
      sessionExecutionBashBackgroundLifecycleParamsSchema.safeParse({
        operation: "bashBackgroundLifecycle",
        ...base,
        mode: "other",
      }).success,
    ).toBe(false);
  });
});
