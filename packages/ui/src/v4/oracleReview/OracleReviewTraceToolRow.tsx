import { SearchIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";

/**
 * 审查轨迹里的工具行：复用会话工具卡的 `ToolLayout`（同款图标位、动作标签、
 * 文件 chip、次行详情与行内 hover），让面板读起来和主对话一致。
 *
 * 轨迹只有 `{toolName, target}` 这类摘要事实（没有 input/output 全量），因此这里
 * 只做「摘要态」渲染：不可展开、无状态词——审查过程里的工具调用到这一步都已结束，
 * 与对话里成功完成的 Read/Search 行本来就不显示状态词。
 */

const ROW_ICON_CLASS = "size-4 shrink-0 text-foreground-subtle";

interface ToolRowPresentation {
  icon: ReactNode;
  kindLabelId: string | null;
}

// 深审白名单目前只有 Read/Grep/Glob/Bash（core workspace-deep-review.ts）；其余
// 工具走兜底行（原工具名 + 目标），白名单扩容时再补展示即可。
const TOOL_ROW_PRESENTATION: Record<string, ToolRowPresentation> = {
  Read: {
    icon: <SearchIcon className={ROW_ICON_CLASS} />,
    kindLabelId: "chat.toolCall.kind.read",
  },
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
};

const FALLBACK_PRESENTATION: ToolRowPresentation = {
  icon: <WrenchIcon className={ROW_ICON_CLASS} />,
  kindLabelId: null,
};

export function OracleReviewTraceToolRow({
  toolId,
  toolName,
  target,
  workspacePath,
}: {
  toolId: string;
  toolName: string;
  target?: string;
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();
  const presentation = TOOL_ROW_PRESENTATION[toolName] ?? FALLBACK_PRESENTATION;
  const kindLabel =
    presentation.kindLabelId === null
      ? toolName
      : intl.formatMessage({ id: presentation.kindLabelId });

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

  const hasTarget = Boolean(target);
  return (
    <ToolLayout
      toolId={toolId}
      icon={presentation.icon}
      canToggle={false}
      kindLabel={kindLabel}
      primaryText={hasTarget ? <span className="min-w-0 truncate">{target}</span> : null}
      prioritizePrimaryText
      title={target ?? toolName}
      content={null}
    />
  );
}
