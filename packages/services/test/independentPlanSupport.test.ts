import { describe, expect, it, vi } from "vitest";
import {
  ensureFusionContextProfileSupport,
  ensureIndependentPlanSupport,
} from "../src/zcode-agent/independentPlanSupport.js";

describe("独立 Plan 执行端能力", () => {
  it("复用同一 CLI 的成功检查，重建 CLI 后重新检查", async () => {
    const first = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(first as never);
    await ensureIndependentPlanSupport(first as never);
    expect(first.request).toHaveBeenCalledTimes(1);
    const second = { request: vi.fn().mockResolvedValue({ independentPlanState: true }) };
    await ensureIndependentPlanSupport(second as never);
    expect(second.request).toHaveBeenCalledTimes(1);
  });
  it("旧 CLI 不认识能力查询时拒绝，不能只相信新 Host 的版本", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureIndependentPlanSupport(client as never)).rejects.toThrow(
      "proto.independentPlanUnsupported",
    );
  });
});

describe("融合档位执行端能力", () => {
  it("显式 fusion 复用同一 CLI 的成功检查", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        independentPlanState: true,
        contextProfileState: true,
        fusionContextProfile: true,
      }),
    };
    await ensureFusionContextProfileSupport(client as never);
    await ensureFusionContextProfileSupport(client as never);
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it("contextProfileState=true 不证明 fusion：缺失 fusionContextProfile 时拒绝，不静默降级", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({ independentPlanState: true, contextProfileState: true }),
    };
    await expect(ensureFusionContextProfileSupport(client as never)).rejects.toThrow(
      "proto.fusionContextProfileUnsupported",
    );
  });
  it("旧 CLI 不认识能力查询时拒绝", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureFusionContextProfileSupport(client as never)).rejects.toThrow(
      "proto.fusionContextProfileUnsupported",
    );
  });
});
