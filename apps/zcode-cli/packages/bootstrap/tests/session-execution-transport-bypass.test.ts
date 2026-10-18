import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ZCodeProtocolNdjsonConnection } from "../src/zcode-protocol/transport.js";

/**
 * 会话执行环境「取消准备」必须旁路 NDJSON 传输的串行处理队列。
 *
 * 事实：传输层把普通请求串行化（`this.processing` 链），只有 sessionStop/
 * workspaceCancelGenerateText/MCP App/workspaceGenerateText 旁路。准备（prepare）含 WSL
 * 部署、实测 26s 级；若取消也排队，它要中止的那个 set 完成前永远进不到 server，取消退化为
 * 空操作。真实实例（lab e 场景）实测：取消 RPC 26s 才返回、准备仍提交。
 */
describe("会话执行环境取消准备旁路", () => {
  const SESSION_EXECUTION = "interaction/sessionExecution";

  it("cancelExecutionEnvironmentPreparation 越过在飞的 setExecutionEnvironment 进入 server", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const setEntered = Promise.withResolvers<void>();
    const finishSet = Promise.withResolvers<void>();
    const cancelEntered = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        const operation = (message as { params?: { operation?: string } }).params?.operation;
        order.push(operation ?? message.method);
        if (operation === "setExecutionEnvironment") {
          setEntered.resolve();
          await finishSet.promise;
        }
        if (operation === "cancelExecutionEnvironmentPreparation") cancelEntered.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    try {
      input.write(
        JSON.stringify({
          id: 1,
          method: SESSION_EXECUTION,
          params: { operation: "setExecutionEnvironment", sessionId: "s1" },
        }) + "\n",
      );
      await setEntered.promise;
      input.write(
        JSON.stringify({
          id: 2,
          method: SESSION_EXECUTION,
          params: { operation: "cancelExecutionEnvironmentPreparation", sessionId: "s1" },
        }) + "\n",
      );
      // 若取消被排进串行队列，这里会等到 vitest 超时（set 未完成前不会进入 handler）。
      await cancelEntered.promise;
      expect(order).toEqual(["setExecutionEnvironment", "cancelExecutionEnvironmentPreparation"]);
    } finally {
      finishSet.resolve();
      input.end();
      await transport.waitForClose();
    }
  });

  it("执行面 run 仍走串行队列（只有 cancel 旁路）", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const setEntered = Promise.withResolvers<void>();
    const finishSet = Promise.withResolvers<void>();
    const runEntered = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        const operation = (message as { params?: { operation?: string } }).params?.operation;
        order.push(operation ?? message.method);
        if (operation === "setExecutionEnvironment") {
          setEntered.resolve();
          await finishSet.promise;
        }
        if (operation === "run") runEntered.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    try {
      input.write(
        JSON.stringify({
          id: 1,
          method: SESSION_EXECUTION,
          params: { operation: "setExecutionEnvironment", sessionId: "s1" },
        }) + "\n",
      );
      await setEntered.promise;
      input.write(
        JSON.stringify({
          id: 2,
          method: SESSION_EXECUTION,
          params: { operation: "run", sessionId: "s1" },
        }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      // run 未旁路：在 set 完成前不得进入 handler。
      expect(order).toEqual(["setExecutionEnvironment"]);
      finishSet.resolve();
      await runEntered.promise;
      expect(order).toEqual(["setExecutionEnvironment", "run"]);
    } finally {
      input.end();
      await transport.waitForClose();
    }
  });
});
