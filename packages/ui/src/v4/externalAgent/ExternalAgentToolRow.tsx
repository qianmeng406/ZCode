import { FileDiffIcon, SearchIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";

/**
 * 外部 agent 活动里的工具行：会话同款 `ToolLayout`（图标位 + 动作标签 + 文件 chip /
 * 命令次行 + hover），让侧栏读起来和主对话一致。
 *
 * 数据只有一行摘要文本（`Name: detail`，由 shared/externalAgentStream 生成），
 * 因此这里做两件事：拆回 (toolName, target) 再按工具选展示形态。摘要态不可展开
 * ——活动记录里没有工具入参/输出全量。
 */

const ROW_ICON_CLASS = "size-4 shrink-0 text-foreground-subtle";

interface ToolRowPresentation {
  icon: ReactNode;
  kindLabelId: string | null;
}

const TOOL_ROW_PRESENTATION: Record<string, ToolRowPresentation> = {
  Read: { icon: <SearchIcon className={ROW_ICON_CLASS} />, kindLabelId: "chat.toolCall.kind.read" },
  Bash: {
    icon: <SquareTerminalIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.terminal",
  },
  Grep: {
    icon: <SearchIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.search",
  },
  Glob: {
    icon: <SearchIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.search",
  },
  WebSearch: {
    icon: <SearchIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.search",
  },
  WebFetch: {
    icon: <SearchIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.webFetch",
  },
  Write: {
    icon: <FileDiffIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.write",
  },
  Edit: {
    icon: <FileDiffIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.edit",
  },
  MultiEdit: {
    icon: <FileDiffIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.edit",
  },
};

const FALLBACK_PRESENTATION: ToolRowPresentation = {
  icon: <WrenchIcon className={ROW_ICON_CLASS} />,
  kindLabelId: null,
};

/**
 * 工具行的图标与文案（Read → 「读取」、Bash → 「终端」…）。
 *
 * 导出的原因：上下文面板里的工具**结果**行要和工具调用行长得一样，同一种工具
 * 在两个地方用两套图标会让人以为是不同的东西。
 */
export function resolveExternalAgentToolPresentation(
  toolName: string,
  formatKindLabel: (id: string) => string,
): { icon: ReactNode; kindLabel: string } {
  const presentation = TOOL_ROW_PRESENTATION[toolName] ?? FALLBACK_PRESENTATION;
  return {
    icon: presentation.icon,
    kindLabel:
      presentation.kindLabelId === null ? toolName : formatKindLabel(presentation.kindLabelId),
  };
}

/** `Bash: ls src` → `{ toolName: "Bash", target: "ls src" }`；没有详情时 target 为空。 */
export function splitExternalAgentToolText(text: string): { toolName: string; target: string } {
  const separator = text.indexOf(": ");
  if (separator <= 0) return { toolName: text.trim(), target: "" };
  return {
    toolName: text.slice(0, separator).trim(),
    target: text.slice(separator + 2).trim(),
  };
}

export function ExternalAgentToolRow({
  toolId,
  text,
  workspacePath,
}: {
  toolId: string;
  text: string;
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();
  const { toolName, target } = splitExternalAgentToolText(text);
  const presentation = TOOL_ROW_PRESENTATION[toolName] ?? FALLBACK_PRESENTATION;
  const kindLabel = resolveExternalAgentToolPresentation(toolName, (id) =>
    intl.formatMessage({ id }),
  ).kindLabel;

  if (toolName === "Read" && target) {
    const descriptor = resolveFileDisplayDescriptor(
      target,
      workspacePath ? { basePath: workspacePath } : {},
    );
    return (
      <ToolLayout
        toolId={toolId}
        icon={presentation.icon}
        canToggle={false}
        kindLabel={kindLabel}
        primaryText={
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-foreground-subtle"
            title={target}
          >
            <FileDisplayIcon src={descriptor.fileIconSrc} size={16} className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{getPathLeaf(target)}</span>
          </span>
        }
        prioritizePrimaryText
        secondaryText={<span className="min-w-0 truncate text-foreground-subtlest">{target}</span>}
        title={target}
        content={null}
      />
    );
  }

  if (toolName === "Bash" && target) {
    // 与会话 execute 行一致：指令走次行、sans 字体、单行截断。
    return (
      <ToolLayout
        toolId={toolId}
        icon={presentation.icon}
        canToggle={false}
        kindLabel={kindLabel}
        primaryText={null}
        secondaryText={<code className="truncate font-sans">{target}</code>}
        title={target}
        content={null}
      />
    );
  }

  return (
    <ToolLayout
      toolId={toolId}
      icon={presentation.icon}
      canToggle={false}
      kindLabel={kindLabel}
      primaryText={target ? <span className="min-w-0 truncate">{target}</span> : null}
      prioritizePrimaryText
      title={target || text}
      content={null}
    />
  );
}
