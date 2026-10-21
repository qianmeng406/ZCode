import { describe, expect, it } from "vitest";
import { toZCodeMode } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

describe("toZCodeMode", () => {
  it("透传 Beta，避免被调用方的 ?? build 静默降级", () => {
    expect(toZCodeMode("beta")).toBe("beta");
  });

  it("保留既有权限映射与缺省语义", () => {
    expect(toZCodeMode("build")).toBe("build");
    expect(toZCodeMode("yolo")).toBe("yolo");
    expect(toZCodeMode("guarded")).toBe("guarded");
    expect(toZCodeMode(undefined)).toBeUndefined();
  });
});
