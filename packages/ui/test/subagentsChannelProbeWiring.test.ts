import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 设置页渠道控件的探测接线护栏。
 *
 * 实测踩过（2026-11-12）：AgentListRow 解构了 probeExternalAgents 却没把它传给
 * SubagentChannelControl——prop 是可选参数，TypeScript 不报错，运行时控件里
 * 恒为 undefined，effect 直接 return，模型下拉永远退成自由输入框。
 * 这种"可选 prop 漏传"用类型系统抓不到，只能靠源码扫描钉住。
 */
const SOURCE = readFileSync("packages/ui/src/settings/SubagentsSection.tsx", "utf8");

describe("SubagentChannelControl 探测接线", () => {
  it("AgentListRow 调用 SubagentChannelControl 时传了 probeExternalAgents", () => {
    const invocation = /<SubagentChannelControl[\s\S]{0,400}?\/>/u.exec(SOURCE)?.[0];
    expect(invocation).toBeDefined();
    expect(invocation).toContain("probeExternalAgents={probeExternalAgents}");
  });

  it("AgentListRow 自身把该 prop 解构出来（否则上面的传递是无源之水）", () => {
    const destructure = /function AgentListRow\(\{[\s\S]{0,600}?\}: \{/u.exec(SOURCE)?.[0];
    expect(destructure).toBeDefined();
    expect(destructure).toContain("probeExternalAgents");
  });

  it("SubagentsSection 渲染 AgentListRow 时传了探测函数", () => {
    const rowUsage = /<AgentListRow[\s\S]{0,2000}?\/>/u.exec(SOURCE)?.[0];
    expect(rowUsage).toBeDefined();
    expect(rowUsage).toContain("probeExternalAgents={probeExternalAgents}");
  });
});

/**
 * 渠道控件与原生模型控件必须**并存**（2026-11-12 用户反馈）。
 *
 * 实测踩过：这两个控件原先写成一个三元（hasChannelControl ? 渠道 : 模型），于是
 * 内置行的「ZCode 内置模型选择器」被渠道下拉顶掉、彻底消失——用户明明没启用任何
 * 外部渠道，却再也调不了 ZCode 自己的模型/档位。
 *
 * 它们是两个独立维度：渠道 = 谁来执行，内置模型 = ZCode 执行时用哪个模型。渠道化
 * 后原生模型才无意义（CLI 用自己的模型），那由 hasModelOverrideControl 的
 * isChannelExternal 判定处理，不该在这一层再互斥一次。
 */
describe("渠道控件与原生模型控件并存", () => {
  it("两个控件各自独立渲染，不是一个顶掉另一个的三元", () => {
    // 取整段渲染区（从渠道控件的条件到模型控件结束）。
    const start = SOURCE.indexOf("{hasChannelControl ? (");
    const modelIdx = SOURCE.indexOf("{hasModelOverrideControl ? (");
    expect(start).toBeGreaterThan(-1);
    expect(modelIdx).toBeGreaterThan(start);
    const region = SOURCE.slice(start, modelIdx + 800);
    // 模型控件以独立条件块出现。
    expect(region).toContain("<SubagentModelOverrideControl");
    // 反证：不允许 `) : hasModelOverrideControl ? (` 这种互斥三元（历史 bug 的写法）。
    expect(SOURCE).not.toContain(") : hasModelOverrideControl ? (");
  });

  it("渠道化时仍通过 isChannelExternal 隐藏原生模型控件（语义互斥只在数据层）", () => {
    expect(SOURCE).toContain(
      "const hasModelOverrideControl = supportsModelOverride(agent) && !isChannelExternal;",
    );
  });
});
