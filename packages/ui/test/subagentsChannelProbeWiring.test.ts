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
