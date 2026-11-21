import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGhRateLimitHint,
  getGhRateLimitHint,
  resetGhRateLimitHintCooldownForTest,
} from "../src/tool/handlers/bash-gh-rate-limit.js";

/**
 * B1-08 工具可用性与提示词一致性。
 *
 * 修复前的提示固定写「use ScheduleWakeup instead of retrying」，而 ScheduleWakeup
 * 在仓库里根本没有 handler（只在 provider-visible-order 的排序名单中），模型照着
 * 调用必然 ToolNotFound。方案要求：提示只推荐当前注册并获准的工具。
 */
describe("gh 限流提示的工具推荐（B1-08）", () => {
  beforeEach(() => {
    resetGhRateLimitHintCooldownForTest();
  });

  it("无注册表信息时不点名任何工具", () => {
    const hint = buildGhRateLimitHint();
    expect(hint).not.toContain("ScheduleWakeup");
    expect(hint).not.toContain("Monitor");
    expect(hint).not.toContain("CronCreate");
    // 但仍要给出可执行的路径。
    expect(hint).toContain("api rate_limit");
  });

  it("Monitor 实际可用时才推荐 Monitor", () => {
    const hint = buildGhRateLimitHint(new Set(["Bash", "Monitor"]));
    expect(hint).toContain("Monitor");
    expect(hint).not.toContain("ScheduleWakeup");
  });

  it("只有 automation 时推荐 CronCreate 并说明它不是轮内等待", () => {
    const hint = buildGhRateLimitHint(new Set(["Bash", "CronCreate"]));
    expect(hint).toContain("CronCreate");
    expect(hint).toContain("not for in-turn waiting");
    expect(hint).not.toContain("ScheduleWakeup");
  });

  it("任何情况下都不出现 ScheduleWakeup", () => {
    for (const tools of [
      undefined,
      new Set<string>(),
      new Set(["Monitor"]),
      new Set(["CronCreate"]),
      new Set(["Monitor", "CronCreate"]),
    ]) {
      expect(buildGhRateLimitHint(tools)).not.toContain("ScheduleWakeup");
    }
  });

  it("非 gh 命令或非限流输出不产生提示", () => {
    expect(getGhRateLimitHint("ls -la", "API rate limit exceeded")).toBeUndefined();
    expect(getGhRateLimitHint("gh pr list", "all good")).toBeUndefined();
  });

  it("命中限流时给出提示，且冷却期内不重复", () => {
    const first = getGhRateLimitHint("gh pr list", "API rate limit exceeded for 1.2.3.4");
    expect(first).toContain("rate limit");
    // 冷却期内第二次不再追加（避免同一轮刷屏）。
    expect(getGhRateLimitHint("gh pr list", "API rate limit exceeded for 1.2.3.4")).toBeUndefined();
  });
});
