// 外部 agent 的输出进度：转成标准的 ToolCallProgress 事件。
//
// 为什么需要：`DelegateToExternalAgent` 可能跑几分钟，用户只看到「工具调用执行中」
// 完全不知道外部 agent 在做什么。执行端的 progress 事件自带 outputPreview
// （含 fullText），这里把它包装成会话事件，投影与 UI 就能共用 Bash 那套进度渲染。
//
// 两条纪律：
// - 事件形状必须与 Bash/MCP 一致（payload 里是 outputPreview/stdoutTail，不是自造字段），
//   否则投影丢弃、UI 看不到；
// - 发送不阻塞：进度只是展示，接口卡住不能把工具本身拖住。
import { SessionEventType } from "@zcode/contracts";
import type { ToolHandler } from "../types.js";

const TAIL_CHARS = 2_000;
const THROTTLE_MS = 300;

export interface ExternalAgentOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
  preview?: unknown;
}

/**
 * 造一个进度发射器（每个工具调用一个）。
 *
 * - 有 `preview` 就透传（执行端的全文预览，UI 直接渲染）；
 * - 只有文本时按节流累计成 tail，避免高频事件；
 * - 任何情况下都不 await，失败静默。
 */
export function createExternalAgentProgressEmitter(
  context: Parameters<ToolHandler>[1],
  toolName: string,
): (chunk: ExternalAgentOutputChunk) => void {
  const startedAt = Date.now();
  let lastEmitAt = 0;
  let tail = "";

  return (chunk) => {
    if (chunk.text) tail = (tail + chunk.text).slice(-TAIL_CHARS);
    const now = Date.now();
    // preview 是权威进度（有就发）；纯文本按节流发。
    if (!chunk.preview && now - lastEmitAt < THROTTLE_MS) return;
    lastEmitAt = now;
    if (!chunk.preview && !tail) return;

    const payload = {
      toolCallId: context.toolCallId,
      toolName,
      elapsedMs: now - startedAt,
      ...(tail ? { stdoutTail: tail } : {}),
      ...(chunk.preview ? { outputPreview: chunk.preview } : {}),
    };
    void Promise.resolve(
      context.emitEvent?.({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ToolCallProgress,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload,
      } as never),
    ).catch(() => undefined);
  };
}
