// S7：内置身份的执行渠道覆盖（core 收敛层）。
//
// 钉住四件事：
// 1. 渠道覆盖达标 → 内置 profile 变 external（backend/preset/外部 system prompt），
//    且 modelSelection/native 专属字段（tools/injectAgentsMd）被剥离；
// 2. Explore 渠道化额外带 profile.permissionMode = preset 声明的只读档位
//    （codebuddy 是 plan、qoderclicn 是 dont_ask——值来自 preset，不是写死）；
// 3. 未达标的 preset（未标 subagentChannelReady）→ 覆盖被忽略，回 native
//    （三道防线之三：手改 state 文件也产不出半残渠道）；
// 4. 无渠道覆盖时既有行为逐字不变。
import { describe, expect, it } from "vitest";
import {
  normalizeAgentProfiles,
  DEFAULT_SUBAGENT_TYPE,
  type AgentProfile,
} from "../src/subagent/profile.js";

const GENERAL = DEFAULT_SUBAGENT_TYPE;
const EXPLORE = "Explore" as const;

describe("normalizeAgentProfiles 执行渠道覆盖", () => {
  it("general-purpose 渠道化：external + codebuddy + 外部 system prompt，native 专属字段剥离", () => {
    const [profile] = normalizeAgentProfiles([], {
      builtInExecutionChannel: { "general-purpose": { presetId: "codebuddy" } },
    });
    expect(profile.name).toBe(GENERAL);
    expect(profile.backend).toBe("external");
    expect(profile.preset).toBe("codebuddy");
    // 外部 system prompt 不引用 ZCode 工具名（外部 CLI 有自己的工具集）。
    expect(profile.systemPrompt).not.toContain("ZCode CLI");
    expect(profile.systemPrompt).toContain("external coding CLI");
    expect(profile.tools).toBeUndefined();
    expect(profile.injectAgentsMd).toBeUndefined();
    // modelSelection 与渠道互斥：即便同时给了模型覆盖也不进 profile。
    expect(profile.modelSelection).toBeUndefined();
  });

  it("Explore 渠道化：external + 只读档位（codebuddy 的 plan）经 profile.permissionMode 承载", () => {
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: { Explore: { presetId: "codebuddy" } },
    });
    const profile = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(profile.backend).toBe("external");
    expect(profile.preset).toBe("codebuddy");
    expect(profile.permissionMode).toBe("plan");
    expect(profile.systemPrompt).toContain("READ-ONLY MODE");
    expect(profile.systemPrompt).not.toContain("ZCode CLI");
    expect(profile.tools).toBeUndefined();
  });

  it("Explore 渠道化：只读档位按 preset 声明取（qoder 是 dont_ask，不是写死的 plan）", () => {
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: { Explore: { presetId: "qodercli-cn" } },
    });
    const profile = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(profile.backend).toBe("external");
    expect(profile.preset).toBe("qodercli-cn");
    // 只读档位必须是 preset 声明的值：qoder 的 --permission-mode plan 会被静默
    // 降级成 default（实测），写死 "plan" 就等于承诺一个不存在的只读保证。
    expect(profile.permissionMode).toBe("dont_ask");
    expect(profile.tools).toBeUndefined();
  });

  it("general-purpose 渠道化不带只读档位（四家都一样：执行型不需要 permissionModeOverride）", () => {
    for (const presetId of ["codebuddy", "opencode", "qodercli-cn", "commandcode"]) {
      const profiles = normalizeAgentProfiles([], {
        builtInExecutionChannel: { "general-purpose": { presetId } },
      });
      const general = profiles.find((entry) => entry.name === GENERAL)!;
      expect(general.preset).toBe(presetId);
      expect(general.permissionMode).toBeUndefined();
    }
  });

  it("opencode 能同时承接两个身份：Explore 带 plan 只读档位（经 --agent 传给 CLI）", () => {
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: {
        "general-purpose": { presetId: "opencode" },
        Explore: { presetId: "opencode" },
      },
    });
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    expect(general.backend).toBe("external");
    expect(general.preset).toBe("opencode");
    expect(general.permissionMode).toBeUndefined();
    const explore = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(explore.backend).toBe("external");
    expect(explore.preset).toBe("opencode");
    // 只读档位由 preset 声明（opencode 的 Plan 是个 agent），invocation 按
    // readOnlyDelivery: "agent" 翻成 `--agent plan`。
    expect(explore.permissionMode).toBe("plan");
  });

  it("未标渠道就绪的 preset（claude-code）→ 覆盖被忽略，回 native", () => {
    // 用 claude-code 而不是 opencode：opencode 已开 general-purpose 渠道
    // （它只缺只读档位，Explore 那条由下面的专门用例覆盖）。
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: {
        "general-purpose": { presetId: "claude-code" },
        Explore: { presetId: "claude-code" },
      },
    });
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    const explore = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(general.backend).toBeUndefined();
    expect(general.tools).toEqual(["*"]);
    expect(explore.backend).toBeUndefined();
    expect(explore.tools).toContain("Grep");
  });

  it("不存在的 preset → 覆盖被忽略；modelSelection 覆盖照常生效", () => {
    const modelSelection = { providerId: "p", modelId: "m" };
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: {
        "general-purpose": { presetId: "no-such-cli" },
        Explore: { presetId: "no-such-cli" },
      },
      builtInModelSelectionOverrides: { [GENERAL]: modelSelection, [EXPLORE]: modelSelection },
    });
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    const explore = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(general.backend).toBeUndefined();
    expect(general.modelSelection).toEqual(modelSelection);
    expect(explore.modelSelection).toEqual(modelSelection);
  });

  it("渠道细配置：model/effort/contextWindow 透传进 profile（Explore 同样生效）", () => {
    const profiles = normalizeAgentProfiles([], {
      builtInExecutionChannel: {
        "general-purpose": {
          presetId: "codebuddy",
          model: "DeepSeek-V4-Pro",
          effort: "high",
          contextWindow: 128000,
        },
        Explore: { presetId: "codebuddy", model: "glm-5.3" },
      },
    });
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    expect(general.model).toBe("DeepSeek-V4-Pro");
    expect(general.effort).toBe("high");
    expect(general.contextWindow).toBe(128000);
    const explore = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(explore.model).toBe("glm-5.3");
    expect(explore.effort).toBeUndefined();
    // Explore 的只读档位仍由 profile.permissionMode 承载，与 CLI 档位互不干扰。
    expect(explore.permissionMode).toBe("plan");
  });

  it("无渠道覆盖：两个内置 profile 与既有形状逐字一致", () => {
    const profiles = normalizeAgentProfiles([], {});
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    const explore = profiles.find((entry) => entry.name === EXPLORE)!;
    expect(general.backend).toBeUndefined();
    expect(general.tools).toEqual(["*"]);
    expect(general.injectAgentsMd).toBe(true);
    expect(explore.injectAgentsMd).toBe(false);
  });

  it("渠道化 profile 仍能被用户同名 profile 覆盖顺序（不改变既有 precedence）", () => {
    const custom: AgentProfile = {
      name: GENERAL,
      description: "user override",
      source: "user",
      systemPrompt: "custom",
    };
    const profiles = normalizeAgentProfiles([custom], {
      builtInExecutionChannel: { "general-purpose": { presetId: "codebuddy" } },
    });
    const general = profiles.find((entry) => entry.name === GENERAL)!;
    // 用户同名 profile 在 Map 里后写覆盖内置——precedence 行为不变。
    expect(general.source).toBe("user");
  });
});
