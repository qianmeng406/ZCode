// 外部 agent 的活动卡数据源：把执行进度收敛成一条会话状态事件。
//
// 为什么不用工具行：后台任务的工具行几百毫秒就结算了，而外部 agent 可能还在跑十几
// 分钟。用户要的是一张**一直可见**的卡：「谁在跑 / 跑了多久 / 最近在做什么」。
//
// 设计要点：
// - 一条事件 = 一份完整快照（不是增量）：投影直接 `state.updated` 替换，客户端不做拼接；
// - 开始/结束各发一次，执行中按节流发（300ms），避免事件风暴；
// - 发送永不阻塞执行（进度丢了不影响任务本身）。
import { SessionEventType, type ExternalAgentActivityPayload } from "@zcode/contracts";
import type { ToolHandler } from "../types.js";

const TAIL_CHARS = 2_000;
const THROTTLE_MS = 300;
const MAX_ENTRIES = 400;
const MAX_ENTRY_CHARS = 24_000;

interface ActivityEntry {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

export interface ExternalAgentActivityReporter {
  /** 绑定读到时调用：卡片立即出现（running，0ms）。 */
  started(info: { label: string; model?: string }): void;
  /** 执行中的输出：节流更新 tail。 */
  progress(chunk: {
    text?: string;
    preview?: unknown;
    entries?: ActivityEntry[];
  }): void;
  /** 收口：success/失败/取消，`terminated` 表示被取消。 */
  settled(outcome: { label?: string; isError?: boolean; durationMs?: number; text?: string }): void;
  /** 主动清空（例如 unbind 或会话切换）。 */
  clear(): void;
}

function previewText(preview: unknown): string | undefined {
  if (!preview || typeof preview !== "object") return undefined;
  const record = preview as { fullText?: unknown; text?: unknown };
  if (typeof record.fullText === "string" && record.fullText.trim()) return record.fullText;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  return undefined;
}

export function createExternalAgentActivityReporter(
  context: Parameters<ToolHandler>[1],
  options: { agentLabel: string; startedAt?: number },
): ExternalAgentActivityReporter {
  const taskId = String(context.toolCallId);
  const startedAt = options.startedAt ?? Date.now();
  let agentLabel = options.agentLabel;
  let tail = "";
  let entries: ActivityEntry[] = [];
  let entriesChars = 0;
  let lastEmitAt = 0;
  let finished = false;

  const emit = (activity: ExternalAgentActivityPayload["activity"], force = false): void => {
    if (!context.emitEvent) return;
    const now = Date.now();
    if (!force && now - lastEmitAt < THROTTLE_MS) return;
    lastEmitAt = now;
    void Promise.resolve(
      context.emitEvent({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ExternalAgentActivityChanged,
        timestamp: new Date(now),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: { activity } satisfies ExternalAgentActivityPayload,
      } as never),
    ).catch(() => undefined);
  };

  /** 追加条目：相邻同类合并（text/reasoning 的增量），并裁剪过旧内容。 */
  const appendEntries = (incoming: ActivityEntry[]) => {
    for (const entry of incoming) {
      if (!entry.text) {
        // 空思考 = “已经开始思考但内容被 CLI 抹掉”的标记：只保留一个。
        if (entry.kind !== "reasoning") continue;
        const last = entries.at(-1);
        if (last && last.kind === "reasoning" && !last.text) continue;
        entries.push({ ...entry });
        continue;
      }
      const last = entries.at(-1);
      if (last && last.kind === entry.kind && entry.kind !== "tool") {
        last.text += entry.text;
        entriesChars += entry.text.length;
      } else {
        entries.push({ ...entry });
        entriesChars += entry.text.length;
      }
    }
    while (entries.length > MAX_ENTRIES || entriesChars > MAX_ENTRY_CHARS) {
      const dropped = entries.shift();
      if (!dropped) break;
      entriesChars -= dropped.text.length;
    }
  };

  const snapshot = (
    status: "running" | "completed" | "failed" | "cancelled",
    extra?: { error?: string },
  ): ExternalAgentActivityPayload["activity"] => ({
    taskId,
    agentLabel,
    status,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    ...(tail ? { tail } : {}),
    ...(entries.length > 0 ? { entries: entries.map((entry) => ({ ...entry })) } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
  });

  return {
    started(info) {
      agentLabel = info.label || agentLabel;
      emit(snapshot("running"), true);
    },
    progress(chunk) {
      if (finished) return;
      if (chunk.entries?.length) {
        appendEntries(chunk.entries);
        emit(snapshot("running"));
        return;
      }
      const text = chunk.text || previewText(chunk.preview);
      if (text) tail = (tail + text).slice(-TAIL_CHARS);
      if (!text) return;
      emit(snapshot("running"));
    },
    settled(outcome) {
      if (finished) return;
      finished = true;
      if (outcome.label) agentLabel = outcome.label;
      // 取消与失败要分开：卡片上"已取消"是用户主动的结果，不是错误。
      const cancelled = context.abortSignal?.aborted === true;
      const status = cancelled ? "cancelled" : outcome.isError ? "failed" : "completed";
      const error =
        !cancelled && outcome.isError && !tail ? outcome.text?.slice(0, 300) : undefined;
      emit(snapshot(status, error ? { error } : undefined), true);
    },
    clear() {
      if (!context.emitEvent) return;
      finished = true;
      emit(null, true);
    },
  };
}
