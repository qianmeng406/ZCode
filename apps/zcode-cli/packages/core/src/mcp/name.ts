import type { McpToolDescriptor } from "@zcode/contracts";

/**
 * MCP 工具默认名的前缀。内置工具从不使用它，因此「这个工具来自 MCP」这个判断
 * 只看前缀即可——工具条目的 metadata 里没有统一的 source/origin 字段。
 */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/** 极简模式按前缀剔除 MCP 工具；descriptor 自带 name 的工具名也以此开头（见 toMcpToolName）。 */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_NAME_PREFIX);
}

export function toMcpToolName(
  descriptor: Pick<McpToolDescriptor, "name" | "serverName" | "toolName">,
): string {
  return (
    descriptor.name ??
    `${MCP_TOOL_NAME_PREFIX}${toModelVisibleMcpNamePart(descriptor.serverName)}__${toModelVisibleMcpNamePart(
      descriptor.toolName,
    )}`
  );
}

export function toModelVisibleMcpNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function matchesModelVisibleMcpServerName(
  requiredName: string,
  serverName: string,
): boolean {
  const expected = requiredName.trim().toLowerCase();
  if (expected.length === 0) return false;

  const rawServerName = serverName.trim().toLowerCase();
  const modelVisibleServerName = toModelVisibleMcpNamePart(serverName).toLowerCase();

  return (
    rawServerName === expected ||
    modelVisibleServerName === expected ||
    rawServerName.includes(expected) ||
    modelVisibleServerName.includes(expected)
  );
}
