import type { AgentListingDelta } from "../agent/agent-listing-metadata.js";
import { type RuntimeAttachmentEntry, type RuntimeMessageEntry } from "../agent/message-history.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import { formatAgentProfileForPrompt } from "./profile.js";

const INITIAL_HEADING = "Available agent types for the Agent tool:";
const ADDED_HEADING = "New agent types are now available for the Agent tool:";
const REMOVED_HEADING = "The following agent types are no longer available:";
const AMBIENT_CONTEXT_NOTE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
const CONCURRENCY_NOTE =
  "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";
// 外部 CLI 子智能体存在时才注入的路由引导（S7 Part B）：按任务形状引导而不是
// 一刀切优先——外部 agent 每次要起独立进程，检索/单文件查询派给它纯属浪费；
// 实现类执行才是它的主场。与工具描述里"缺省 general-purpose"不冲突：这里只
// 引导"实现类任务显式指定外部 agent"，缺省行为不变。
const EXTERNAL_CHANNEL_NOTE =
  "External CLI agents run in their own process with their own permissions — for implementation-type tasks (editing files, running commands, multi-step execution), prefer naming an external CLI agent explicitly in subagent_type; keep read-only searches and single-file lookups on Explore or native agents.";

export function collectAgentListingAttachment(input: {
  definitions: AgentDefinitionsSnapshot;
  entries: readonly RuntimeMessageEntry[];
  tools: readonly { name: string }[];
  embeddedSearchEnabled?: boolean;
}): RuntimeAttachmentEntry | undefined {
  if (!input.tools.some((tool) => tool.name === "Agent")) return undefined;
  const announced = new Set<string>();
  for (const entry of input.entries) {
    if (entry.kind !== "attachment" || entry.metadata.source !== "agent_listing_delta") continue;
    // 历史写入/恢复边界已校验并复制 delta；本轮新增 delta 由收集器生成。
    // 此处只读名称增删，避免每次请求重复校验并分配临时数组与 Set。
    const delta = entry.metadata.agentListingDelta;
    if (!delta) continue;
    for (const name of delta.addedTypes) announced.add(name);
    for (const name of delta.removedTypes) announced.delete(name);
  }
  const active = input.definitions.activeAgents;
  const current = new Set(active.map((profile) => profile.name));
  const added = active.filter((profile) => !announced.has(profile.name));
  const removedTypes: string[] = [];
  for (const name of announced) {
    if (!current.has(name)) removedTypes.push(name);
  }
  if (added.length === 0 && removedTypes.length === 0) return undefined;
  // 外部 CLI profile 排前（组内保持字母序）：主 agent 扫列表时先看到执行渠道。
  // 顺序只是次要信号——主要路由信号仍是每条的 description（S7 Part B）。
  added.sort((left, right) => {
    const leftExternal = left.backend === "external";
    const rightExternal = right.backend === "external";
    if (leftExternal !== rightExternal) return leftExternal ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  removedTypes.sort();
  const showExternalChannelNote = added.some((profile) => profile.backend === "external");
  const delta: AgentListingDelta = {
    addedTypes: added.map((profile) => profile.name),
    addedLines: added.map((profile) => formatAgentProfileForPrompt(profile, input)),
    removedTypes,
    isInitial: announced.size === 0,
    showConcurrencyNote: true,
    // 进 delta 结构：恢复重放时 attachment content 已持久化，不需要重算；
    // 结构化保留让测试与将来重格式化有单一事实来源。
    showExternalChannelNote,
  };
  return {
    kind: "attachment",
    content: formatAgentListingDelta(delta),
    metadata: { source: "agent_listing_delta", agentListingDelta: delta },
  };
}

function formatAgentListingDelta(delta: AgentListingDelta): string {
  const sections: string[] = [];
  if (delta.addedLines.length > 0) {
    sections.push(
      `${delta.isInitial ? INITIAL_HEADING : ADDED_HEADING}\n${delta.addedLines.join("\n")}`,
    );
  }
  if (delta.showExternalChannelNote) sections.push(EXTERNAL_CHANNEL_NOTE);
  if (delta.removedTypes.length > 0) {
    sections.push(
      `${REMOVED_HEADING}\n${delta.removedTypes.map((name) => `- ${name}`).join("\n")}`,
      AMBIENT_CONTEXT_NOTE,
    );
  }
  if (delta.isInitial && delta.showConcurrencyNote) sections.push(CONCURRENCY_NOTE);
  return sections.join("\n\n");
}
