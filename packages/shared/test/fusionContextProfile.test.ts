import { expect, it } from "vitest";
import {
  contextProfileSchema,
  resolveContextProfile,
  resolveExecutionState,
  resolveRestoredExecutionState,
} from "../src/execution-state.js";
import { zcodeRuntimeCapabilitiesSchema } from "../src/zcode-protocol/index.js";
import { hostCapabilitiesSchema } from "../src/zcode-protocol-v4/transport.js";

it("contextProfileSchema accepts fusion alongside standard and minimal", () => {
  // fusion 是 additive 档位值：schema 是唯一契约源，三条链路（输入/快照/恢复）共用它。
  expect(contextProfileSchema.safeParse("fusion").success).toBe(true);
  expect(contextProfileSchema.safeParse("standard").success).toBe(true);
  expect(contextProfileSchema.safeParse("minimal").success).toBe(true);
  expect(contextProfileSchema.safeParse("unknown").success).toBe(false);
});

it("resolveExecutionState accepts explicit fusion and preserves mode/plan", () => {
  // 非构建权限 + 显式 fusion 档位：历史组合原样保留，不被 Beta 迁移。
  const state = resolveExecutionState(
    { contextProfile: "fusion" },
    { mode: "yolo", planEnabled: false, contextProfile: "standard" },
  );
  expect(state).toEqual({ mode: "yolo", planEnabled: false, contextProfile: "fusion" });
});

it("fusion does not create a mode fallback: legacy mode=minimal still yields minimal", () => {
  // 融合档位只由显式 contextProfile=fusion 表达；旧 mode=minimal 兼容映射不变。
  expect(resolveContextProfile({ mode: "minimal" })).toBe("minimal");
  expect(resolveExecutionState({ mode: "minimal" })).toEqual({
    mode: "minimal",
    planEnabled: false,
    contextProfile: "minimal",
  });
});

it("missing contextProfile still defaults to standard", () => {
  expect(resolveContextProfile({})).toBe("standard");
  expect(resolveExecutionState({})).toEqual({
    mode: "build",
    planEnabled: false,
    contextProfile: "standard",
  });
});

it("plan/permission patches preserve fusion profile until an explicit mode switch", () => {
  // 只切 Plan（无 mode 无档位）不改历史融合档位。
  const current = { mode: "yolo", planEnabled: false, contextProfile: "fusion" as const };
  expect(resolveExecutionState({ planEnabled: true }, current).contextProfile).toBe(
    "fusion",
    "切 Plan 不改融合档位",
  );
  // Beta 读取升级：恢复 build+fusion 完整历史状态无损映射为 Beta（专用恢复入口）。
  expect(
    resolveRestoredExecutionState({
      mode: "build",
      planEnabled: false,
      contextProfile: "fusion",
    }),
  ).toEqual({ mode: "beta", planEnabled: false, contextProfile: "standard" });
  // 其余权限 + fusion 的历史组合不静默改权限，恢复时保留。
  expect(
    resolveRestoredExecutionState({
      mode: "yolo",
      planEnabled: false,
      contextProfile: "fusion",
    }),
  ).toEqual({ mode: "yolo", planEnabled: false, contextProfile: "fusion" });
  // 任何来源的 beta+fusion 恢复值都归一为 Beta+standard（Beta 强制完整上下文）。
  expect(
    resolveRestoredExecutionState({
      mode: "beta",
      planEnabled: true,
      contextProfile: "fusion",
    }),
  ).toEqual({ mode: "beta", planEnabled: true, contextProfile: "standard" });
  // 显式切回非 beta 模式：清遗留 fusion，且不反迁移回 Beta。
  expect(resolveExecutionState({ mode: "build" }, current)).toEqual({
    mode: "build",
    planEnabled: false,
    contextProfile: "standard",
  });
  // 同模式重申（含带 mode 字段的常规提交）不是切换：历史组合继续按历史语义执行。
  expect(resolveExecutionState({ mode: "yolo", contextProfile: "fusion" }, current)).toEqual(
    current,
  );
  // 真正变更为另一个非 beta 模式才清融合。
  expect(resolveExecutionState({ mode: "guarded", contextProfile: "fusion" }, current)).toEqual({
    mode: "guarded",
    planEnabled: false,
    contextProfile: "standard",
  });
  // 仅权限/Plan patch（mode 缺省沿用 current）保留 yolo+fusion 历史组合。
  expect(resolveExecutionState({ planEnabled: true }, current)).toEqual({
    mode: "yolo",
    planEnabled: true,
    contextProfile: "fusion",
  });
  // 无效 mode 值沿用 current，不静默切换或改档位。
  expect(resolveExecutionState({ mode: "unknown-mode" }, current)).toEqual(current);
});

it("beta mode forces standard profile and overrides legacy minimal filtering", () => {
  // Beta 必须拿到完整上下文与完整工具：覆盖遗留 minimal/fusion 过滤。
  expect(
    resolveExecutionState(
      { mode: "beta" },
      { mode: "minimal", planEnabled: false, contextProfile: "minimal" },
    ),
  ).toEqual({ mode: "beta", planEnabled: false, contextProfile: "standard" });
  expect(
    resolveExecutionState({
      mode: "beta",
      planEnabled: false,
      contextProfile: "fusion",
    }),
  ).toEqual({ mode: "beta", planEnabled: false, contextProfile: "standard" });
});

it("additive fusionContextProfile capability bit negotiates on both wires", () => {
  // additive 位：旧端缺失等价 false；=== true 才视为支持。
  expect(zcodeRuntimeCapabilitiesSchema.safeParse({ fusionContextProfile: true }).success).toBe(
    true,
  );
  expect(zcodeRuntimeCapabilitiesSchema.safeParse({}).success).toBe(true);
  const baseCapabilities = {
    nativeDialogs: true,
    localTerminal: true,
    binaryFrames: false,
    compression: "none",
  } as const;
  expect(
    hostCapabilitiesSchema.safeParse({ ...baseCapabilities, fusionContextProfile: true }).success,
  ).toBe(true);
  expect(hostCapabilitiesSchema.safeParse({ ...baseCapabilities }).success).toBe(true);
});
