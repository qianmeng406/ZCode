import { expect, it } from "vitest";
import {
  contextProfileSchema,
  resolveContextProfile,
  resolveExecutionState,
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
  const state = resolveExecutionState(
    { contextProfile: "fusion" },
    { mode: "build", planEnabled: false, contextProfile: "standard" },
  );
  expect(state).toEqual({ mode: "build", planEnabled: false, contextProfile: "fusion" });
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

it("profile-only switch preserves fusion profile across permission/plan changes", () => {
  const current = { mode: "build", planEnabled: false, contextProfile: "fusion" as const };
  expect(resolveExecutionState({ mode: "yolo" }, current).contextProfile).toBe(
    "fusion",
    "改权限不改融合档位",
  );
  expect(resolveExecutionState({ planEnabled: true }, current).contextProfile).toBe(
    "fusion",
    "切 Plan 不改融合档位",
  );
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
