import { describe, expect, it, vi } from "vitest";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import {
  formatSessionExecutionPrepareFailureDetail,
  injectSessionExecutionPort,
} from "../src/zcode-protocol/session-execution-port-inject.js";

/**
 * 恢复/创建路径的 fail-closed 文案必须带出底层原因。
 *
 * 现场缺陷：Preview 应用恢复一个 WSL 会话时只显示
 * 「session execution environment preparation failed; execution is blocked until the
 * environment is ready」，真正原因（随包服务端包不含 session-linux-execution 通道 →
 * environment_unavailable / Unknown channel … timed out）只在宿主日志里，用户无从判断。
 */

function wslAppOptions(environment?: unknown) {
  return {
    sessionId: "sess-inject",
    sessionStore: {
      sessionEntries: vi.fn(async () => (environment === undefined ? [] : [{ data: environment }])),
    },
    runtimeConfig: { workingDirectory: "C:\\proj" },
  } as unknown as Parameters<typeof injectSessionExecutionPort>[0];
}

function serverWith(
  requestClient: ZCodeProtocolAgentServerContext["requestClient"],
): ZCodeProtocolAgentServerContext {
  return { requestClient } as unknown as ZCodeProtocolAgentServerContext;
}

const WSL_ENV = { kind: "wsl", distro: "Ubuntu-24.04", user: "zcodewslp2" };

describe("session execution port inject（恢复路径的可诊断性）", () => {
  it("宿主返回失败封套时，抛出文案带出底层 code 与 message", async () => {
    const requestClient = vi.fn(async () => ({
      ok: false as const,
      code: "environment_unavailable",
      message: "Channel name 'session-linux-execution' timed out after 1000ms",
    }));
    const options = wslAppOptions(WSL_ENV);

    await expect(injectSessionExecutionPort(options, serverWith(requestClient))).rejects.toThrow(
      /session execution environment preparation failed \(environment_unavailable: Channel name 'session-linux-execution' timed out after 1000ms\); execution is blocked until the environment is ready/,
    );
  });

  it("宿主调用抛异常时，抛出文案带出异常消息", async () => {
    const requestClient = vi.fn(async () => {
      throw new Error("interaction/sessionExecution unavailable");
    });

    await expect(
      injectSessionExecutionPort(wslAppOptions(WSL_ENV), serverWith(requestClient)),
    ).rejects.toThrow(
      /preparation failed \(interaction\/sessionExecution unavailable\); execution is blocked/,
    );
  });

  it("未配置环境（local）时不发起 prepare，行为不变", async () => {
    const requestClient = vi.fn(async () => ({ ok: false as const, code: "x", message: "y" }));
    const injected = await injectSessionExecutionPort(wslAppOptions(), serverWith(requestClient));

    expect(injected?.binding).toBeDefined();
    expect(requestClient).not.toHaveBeenCalled();
  });

  it("取不到原因时保持原文案（不产生空括号）", () => {
    expect(formatSessionExecutionPrepareFailureDetail(undefined, undefined)).toBe("");
    expect(formatSessionExecutionPrepareFailureDetail(undefined, { ok: false })).toBe("");
    expect(formatSessionExecutionPrepareFailureDetail(new Error("boom"), { ok: true })).toBe(
      " (boom)",
    );
  });
});
