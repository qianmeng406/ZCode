import { describe, expect, it } from "vitest";
import { exampleGenUiPrepare } from "./contract.example.js";
import { IGenUiService, type GenUiPrepareParams } from "./contract.js";

// 契约测试：只锚定 gen-ui-service 的对外契约（频道名、示例字段、宿主替身往返），
// 不泄漏执行侧实现。architecture-governance 要求 managed 模块具备该产物。
describe("gen-ui-service contract", () => {
  it("描述符绑定 gen-ui 频道", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("契约示例只使用契约声明的 prepare 字段", () => {
    const params: GenUiPrepareParams = exampleGenUiPrepare;
    expect(params.instanceKey).toBe("message-1");
    expect(params.ownerWebContentsId).toBeGreaterThan(0);
    expect(params.html).toContain("chart");
    expect(params.path).toBe("/workspace/chart.html");
  });

  it("只依赖契约方法的宿主替身即可完成 prepare 与 state 往返", async () => {
    const listScopes: string[] = [];
    const service: IGenUiService = {
      readDocument: async (target) => ({ path: target.path, html: "<html></html>" }),
      prepareSandbox: async (input) => ({
        instance: {
          runtimeId: "test-agent",
          generation: 1,
          token: "test-token",
          appIdentity: "a".repeat(64),
        },
        sandboxId: `sb-${input.instanceKey}`,
        initId: 1,
        shellUrl: `zcode-sandbox://shell-sb-${input.instanceKey}/`,
        partition: `plugin-sandbox:${input.instanceKey}`,
      }),
      getState: async () => null,
      setState: async () => undefined,
      listState: async (scope) => {
        listScopes.push(scope.sessionId);
        return [];
      },
      onStateChanged: () => ({ dispose: () => undefined }),
    };

    const handle = await service.prepareSandbox(exampleGenUiPrepare);
    expect(handle.sandboxId).toBe("sb-message-1");
    expect(await service.getState(exampleGenUiPrepare)).toBeNull();
    expect(await service.listState(exampleGenUiPrepare)).toEqual([]);
    expect(listScopes).toEqual(["session"]);
  });
});
