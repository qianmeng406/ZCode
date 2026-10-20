import { describe, expect, it, vi } from "vitest";
import {
  ensureBetaModeSupport,
  ensureFusionContextProfileSupport,
  ensureIndependentPlanSupport,
  supportsHistoryFirst,
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

describe("Beta 独立工作模式执行端能力", () => {
  it("显式 mode=beta 复用同一 CLI 的成功检查", async () => {
    const client = {
      request: vi.fn().mockResolvedValue({
        independentPlanState: true,
        contextProfileState: true,
        fusionContextProfile: true,
        betaMode: true,
      }),
    };
    await ensureBetaModeSupport(client as never);
    await ensureBetaModeSupport(client as never);
    expect(client.request).toHaveBeenCalledTimes(1);
  });
  it("fusionContextProfile=true 不证明 Beta：缺失 betaMode 时拒绝，不静默降级", async () => {
    // 历史能力位只证明融合档位支持；Beta 是独立 additive 能力，独立判定。
    const client = {
      request: vi.fn().mockResolvedValue({
        independentPlanState: true,
        contextProfileState: true,
        fusionContextProfile: true,
      }),
    };
    await expect(ensureBetaModeSupport(client as never)).rejects.toThrow(
      "proto.betaModeUnsupported",
    );
  });
  it("旧 CLI 不认识能力查询时拒绝", async () => {
    const client = { request: vi.fn().mockRejectedValue(new Error("Method not found")) };
    await expect(ensureBetaModeSupport(client as never)).rejects.toThrow(
      "proto.betaModeUnsupported",
    );
  });
});

describe("历史先显示执行端能力", () => {
  it("同一 CLI 只查询一次，只有显式 true 才开启", async () => {
    const client = { request: vi.fn().mockResolvedValue({ historyFirst: true }) };
    expect(
      await Promise.all([
        supportsHistoryFirst(client as never),
        supportsHistoryFirst(client as never),
      ]),
    ).toEqual([true, true]);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(
      await supportsHistoryFirst({
        request: vi.fn().mockResolvedValue({ independentPlanState: true }),
      } as never),
    ).toBe(false);
  });
  it("旧方法或临时请求失败不发送新订阅字段，下一次可重新协商", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("Method not found"))
        .mockResolvedValue({ historyFirst: true }),
    };
    expect(await supportsHistoryFirst(client as never)).toBe(false);
    expect(await supportsHistoryFirst(client as never)).toBe(true);
  });
});
