import { describe, expect, it } from "vitest";
import {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "../src/lib/userActionTraceCatalog.js";

describe("user action trace catalog", () => {
  it("固定 24 个 Core 与 16 个 Settings 叶子 feature", () => {
    expect(Object.keys(CORE_USER_ACTION_FEATURES)).toHaveLength(24);
    expect(Object.keys(SETTINGS_USER_ACTION_FEATURES)).toHaveLength(16);
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "core")).toHaveLength(94);
    // fork 新增性能页 6 个开关动作（含从外观迁来的收纳开关），settings 组条目由 46 增至 52；
    // 收纳开关此前未登记（遥测静默 NOOP），这次随迁移一并补上。
    // 空闲卡顿治理再加 4 个性能开关动作（粒子/高亮缓存/扫描收敛/轮询去重），52 → 56。
    expect(USER_ACTION_CATALOG.filter((entry) => entry.group === "settings")).toHaveLength(56);
  });

  it("feature/action 组合唯一且不使用动态标识", () => {
    const keys = USER_ACTION_CATALOG.map((entry) => `${entry.featureId}:${entry.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry.featureId).toMatch(/^[a-z]+(?:[._][a-z]+)+$/u);
      expect(entry.action).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(entry.featureId).not.toMatch(/taskId|workspacePath|pluginId/iu);
    }
  });

  it("不声明 /event/report sink", () => {
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry).not.toHaveProperty("eventPolicy");
      expect(entry).not.toHaveProperty("elementName");
    }
  });
});
