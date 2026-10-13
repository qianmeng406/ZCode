import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "../src/config/schema.js";

/**
 * 内置 Provider Config 的回归护栏。
 *
 * 目录是打进安装包的资源（electron-builder 的 extraResources），解析失败会直接让模型设置页
 * 拿不到任何内置渠道；本测试用真实 schema 解析仓库里的目录，保证改动不会悄悄破坏它。
 */

const catalog = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../config/provider/zcode-builtin.json"), "utf-8"),
) as {
  schemaVersion: number;
  revision: number;
  config: { providerConfigRules: unknown; modelConfigRules: unknown };
};

test("内置目录的 providerConfigRules 能通过 schema 解析", () => {
  const parsed = parseZCodeBuiltinProviderConfigRules(catalog.config.providerConfigRules);
  assert.ok(parsed.providers.keys().length > 0, "内置渠道不能为空");
  // 智谱套餐渠道必须仍在，避免新增分组时误删既有条目。
  assert.ok(parsed.providers.has("account:bigmodel-individual-coding-plan"));
  assert.ok(parsed.providers.has("account:zai-start-plan"));
});

test("内置目录的 modelConfigRules 能通过 schema 解析", () => {
  assert.doesNotThrow(() => parseZCodeBuiltinModelConfigRules(catalog.config.modelConfigRules));
});
