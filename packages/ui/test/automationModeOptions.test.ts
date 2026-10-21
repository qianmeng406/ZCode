import { describe, expect, it } from "vitest";
import { buildAutomationModeOption } from "../src/settings/automationAgentConfigOptions.js";

describe("buildAutomationModeOption", () => {
  it("只暴露定时/闲时协议支持的权限档，不展示 Beta 与 research", () => {
    const option = buildAutomationModeOption("build");
    const values = (option.options ?? []).map((entry) => entry.value);
    expect(values).toEqual(["build", "guarded", "plan", "yolo"]);
    expect(values).not.toContain("beta");
    expect(values).not.toContain("research");
  });

  it("保留当前值，不因候选过滤篡改已保存模式", () => {
    expect(buildAutomationModeOption("yolo").currentValue).toBe("yolo");
  });
});
