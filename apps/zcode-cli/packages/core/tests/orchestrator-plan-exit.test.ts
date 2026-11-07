// ExitPlanMode 在主控（绑定外部 agent）下的前置拦截。
//
// 实测（2026-11-07）：模型在主控里调 ExitPlanMode，唯一写入口抛出通用的
// 「先解绑」错误——模型把它当死胡同，在「退计划/解绑」之间打转，没有意识到
// 留在主控里委派才是设计好的工作方式。handler 现在先行拦截并指路。
import { describe, expect, it } from "vitest";
import { exitPlanModeHandler } from "../src/tool/handlers/plan-mode.js";

function makeContext(port: unknown) {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    spanId: "span-1",
    parentSpanId: undefined,
    turnId: undefined,
    sessionModePort: port,
  } as never;
}

const planInput = { plan: "- step one\n- step two" };

describe("ExitPlanMode 主控拦截", () => {
  it("绑定外部 agent 时拒绝退出并指向委派，而不是通用报错", async () => {
    const port = {
      isPlanEnabled: () => true,
      isExternalAgentReadOnly: () => true,
      getMode: () => "build" as const,
    };
    await expect(
      exitPlanModeHandler(planInput, makeContext(port)),
    ).rejects.toThrow(/Orchestrator mode/);
  });

  it("错误可恢复（模型拿到的是指引，不是终结性失败）", async () => {
    const port = {
      isPlanEnabled: () => true,
      isExternalAgentReadOnly: () => true,
      getMode: () => "build" as const,
    };
    try {
      await exitPlanModeHandler(planInput, makeContext(port));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { recoverable?: boolean }).recoverable).toBe(true);
      expect((error as { context?: { toolName?: string } }).context?.toolName).toBe("ExitPlanMode");
    }
  });

  it("未绑定（正常 plan 模式）时不受拦截影响，走到退出转换", async () => {
    let exitCalled = false;
    const port = {
      isPlanEnabled: () => true,
      isExternalAgentReadOnly: () => false,
      getMode: () => "build" as const,
      async exitPlanMode() {
        exitCalled = true;
        return { mode: "build" as const, previousMode: "build" as const };
      },
    };
    await exitPlanModeHandler(planInput, makeContext(port));
    expect(exitCalled).toBe(true);
  });

  it("端口未实现 isExternalAgentReadOnly（旧宿主）时行为不变", async () => {
    let exitCalled = false;
    const port = {
      isPlanEnabled: () => true,
      getMode: () => "build" as const,
      async exitPlanMode() {
        exitCalled = true;
        return { mode: "build" as const, previousMode: "build" as const };
      },
    };
    await exitPlanModeHandler(planInput, makeContext(port));
    expect(exitCalled).toBe(true);
  });
});
