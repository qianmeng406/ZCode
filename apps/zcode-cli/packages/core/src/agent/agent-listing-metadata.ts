/** 持久化目录增量；恢复只信结构化数据，不从自然语言正文推断已通知类型。 */
export interface AgentListingDelta {
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
  /**
   * addedLines 里含外部 CLI profile 时为 true（S7 Part B 的路由引导行）。
   * optional：老会话持久化的 delta 没有该字段，恢复时按 false 处理——
   * 那些会话当时本来也没注入过引导行。
   */
  showExternalChannelNote?: boolean;
}

export function parseAgentListingDelta(value: unknown): AgentListingDelta | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { addedTypes, addedLines, removedTypes, isInitial, showConcurrencyNote } = value as Record<
    string,
    unknown
  >;
  if (
    !isStringArray(addedTypes) ||
    !isStringArray(addedLines) ||
    !isStringArray(removedTypes) ||
    typeof isInitial !== "boolean" ||
    typeof showConcurrencyNote !== "boolean" ||
    addedTypes.length !== addedLines.length ||
    new Set(addedTypes).size !== addedTypes.length ||
    new Set(removedTypes).size !== removedTypes.length ||
    addedTypes.some((name) => removedTypes.includes(name))
  )
    return undefined;
  return {
    addedTypes: [...addedTypes],
    addedLines: [...addedLines],
    removedTypes: [...removedTypes],
    isInitial: isInitial,
    showConcurrencyNote: showConcurrencyNote,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
