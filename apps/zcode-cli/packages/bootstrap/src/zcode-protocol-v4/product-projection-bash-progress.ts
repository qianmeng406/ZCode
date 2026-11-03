import {
  executionOutputPreviewSchema,
  type ConversationDelta,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallProgressPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";

/**
 * 允许实时输出预览的工具（与 Bash 同一套渲染）。
 *
 * 外部 agent 的委派可能跑几分钟，用户必须能在工具卡里看到它正在做什么——
 * 只靠主 agent 轮询等于没有进度。名字在这里写死而不是从 core 引：bootstrap
 * 不依赖 core 的工具注册表，跨层引用会把两边的发布节奏绑死。
 */
const LIVE_OUTPUT_TOOL_NAMES = new Set([
  "Bash",
  "DelegateToExternalAgent",
  "StartExternalAgentTask",
]);

/** 进度只能更新已运行的工具行，不创建行、不把终态或后台任务复活。 */
export function projectToolActivity(
  event: SessionEvent,
  row: ToolCallRow | undefined,
): ConversationDelta[] {
  if (!row) return [];
  if (event.type === SessionEventType.ToolCallStarted) {
    const payload = event.payload as ToolCallStartedPayload;
    return [
      {
        op: "row.upserted",
        row: {
          ...row,
          status: "running",
          startedAt: event.timestamp.getTime(),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
    ];
  }
  if (!LIVE_OUTPUT_TOOL_NAMES.has(row.toolName) || row.status !== "running" || row.backgrounded)
    return [];
  const parsed = executionOutputPreviewSchema.safeParse(
    (event.payload as ToolCallProgressPayload).outputPreview,
  );
  if (!parsed.success) return [];
  return [{ op: "row.upserted", row: { ...row, outputPreview: parsed.data } }];
}

/** 统一在投影事务中清掉预览，涵盖 result/error、Stop、转后台与轮次收口。 */
export function clearSettledOutputPreviews(deltas: ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (
      (delta.op !== "row.upserted" && delta.op !== "row.appended") ||
      delta.row.kind !== "toolCall" ||
      !delta.row.outputPreview ||
      (delta.row.status === "running" && !delta.row.backgrounded)
    )
      return delta;
    const { outputPreview: _preview, ...row } = delta.row;
    return { ...delta, row };
  });
}
