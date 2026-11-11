import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeConfig,
} from "@zcode/shared";

/** 独立 CLI 的磁盘 loader 复用共享纯解析器，保留原文件配置来源。 */
import type { RuntimeSubagentConfiguration } from "./contract.js";

export function parseRuntimeSubagentConfig(configuration: RuntimeSubagentConfiguration) {
  const profiles: AgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    profiles.push(
      document.namespace
        ? { ...result.profile, name: `${document.namespace}/${result.profile.name}` }
        : result.profile,
    );
  }
  return {
    ...resolveSubagentRuntimeProfiles(profiles, configuration.state),
    diagnostics,
  };
}

/**
 * Host 已完成纯解析；失败回退不能混入旧模板或磁盘覆盖。
 *
 * 执行渠道覆盖（S7）**不走 snapshot**：snapshot 经 strict schema 的跨版本 RPC
 * 传输（远端 host/CLI 版本可能不同步，新字段会让旧端 strict reject 整份配置），
 * 渠道只走磁盘 loader 与 runtimeConfig 两条同进程路径——snapshot 场景恒 native。
 */
export function subagentProfilesFromSnapshot(snapshot: SubagentRuntimeConfig) {
  return snapshot.kind === "ready"
    ? { ...snapshot, builtInExecutionChannel: {} }
    : {
        profiles: [],
        builtInModelSelectionOverrides: {},
        builtInExecutionChannel: {},
        pluginAgentModelSelectionOverrides: {},
      };
}
