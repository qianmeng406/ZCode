/**
 * Dream 手动触发的结果文案。
 *
 * 只做 `result → intl 文案` 的纯映射：服务端返回的 `reason` 是机器码
 * （memory_disabled / remote_workspace / extraction_pending …），禁止直接透传给用户。
 */
import type { ZCodeSessionRunMemoryDreamResult } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/** 失败原因可能带模型/文件系统原文；截断后再拼进 toast，避免整段栈信息糊在界面上。 */
const MAX_FAILURE_REASON_CHARS = 160;

export function formatMemoryDreamResult(
  intl: IntlShape,
  result: ZCodeSessionRunMemoryDreamResult,
): string {
  switch (result.status) {
    case "completed": {
      if (result.changes.length === 0) {
        return intl.formatMessage({ id: "chat.memoryDream.completedNoChanges" });
      }
      const added = result.changes.reduce((sum, change) => sum + change.addedLines, 0);
      const removed = result.changes.reduce((sum, change) => sum + change.removedLines, 0);
      return intl.formatMessage(
        { id: "chat.memoryDream.completed" },
        { files: result.changes.length, added, removed },
      );
    }
    case "skipped":
      return intl.formatMessage({ id: skippedReasonId(result.reason) });
    case "already_running":
      return intl.formatMessage({ id: "chat.memoryDream.alreadyRunning" });
    case "busy":
      return intl.formatMessage({ id: "chat.memoryDream.busy" });
    case "disabled":
      return intl.formatMessage({ id: disabledReasonId(result.reason) });
    case "failed": {
      const reason = result.reason?.trim().slice(0, MAX_FAILURE_REASON_CHARS);
      return reason
        ? intl.formatMessage({ id: "chat.memoryDream.failedWithReason" }, { reason })
        : intl.formatMessage({ id: "chat.memoryDream.failed" });
    }
  }
}

function skippedReasonId(reason: string | undefined): string {
  switch (reason) {
    case "insufficient_transcripts":
      return "chat.memoryDream.skippedNoTranscripts";
    case "not_due":
      return "chat.memoryDream.skippedNotDue";
    default:
      return "chat.memoryDream.skipped";
  }
}

function disabledReasonId(reason: string | undefined): string {
  switch (reason) {
    case "fork_feature_disabled":
      return "chat.memoryDream.disabledFeature";
    case "memory_disabled":
      return "chat.memoryDream.disabledMemory";
    case "remote_workspace":
      return "chat.memoryDream.disabledRemote";
    default:
      return "chat.memoryDream.disabled";
  }
}
