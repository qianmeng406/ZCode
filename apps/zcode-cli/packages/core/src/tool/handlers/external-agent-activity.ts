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
// 条目总字符上限：1 分钟以上的委派很容易超过小上限，从最老开始丢会让面板
// "内容不全"。48k 字符 ≈ 1.6 万汉字，单条事件仍远小于 IPC/落库的舒适区。
const MAX_ENTRY_CHARS = 48_000;

interface ActivityEntry {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

export interface ExternalAgentActivityReporter {
  /** 绑定读到时调用：卡片立即出现（running，0ms）。 */
  started(info: { label: string; model?: string }): void;
  /** 执行中的输出：节流更新 tail。 */
  progress(chunk: { text?: string; preview?: unknown; entries?: ActivityEntry[] }): void;
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
  let model: string | undefined;
  let tail = "";
  let entries: ActivityEntry[] = [];
  let entriesChars = 0;
  let lastEmitAt = 0;
  let finished = false;
  // 因超出上限被裁掉的条目数：面板用它在顶部提示「更早过程已折叠」，
  // 否则长任务的开头被静默裁掉，用户只会觉得"内容不全"。
  let trimmedEntries = 0;

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
      trimmedEntries += 1;
    }
  };

  /**
   * 用 CLI 的最终正文把最后一块流式正文补完整。
   *
   * 流式 text_delta 一遇到 tool_use 就断开，最后一块正文可能停在半句话/半个
   * markdown 结构上；driver 解析出的 result 才是完整正文。只在前者恰好是后者
   * 的前缀延伸时替换（等长或被包含都不动），绝不无脑追加——那是正文出现两遍
   * 的老坑。result 解析失败时 driver 会退回 raw stdout（JSONL），那不是正文，
   * 不能拿去替换。
   */
  const reconcileFinalText = (finalText: string | undefined): void => {
    const text = finalText?.trim();
    if (!text || text.startsWith("{")) return;
    const last = entries.findLast((entry) => entry.kind === "text" && entry.text.trim());
    if (!last) return;
    const streamed = last.text.trim();
    if (text === streamed) return;
    if (text.length > streamed.length && text.startsWith(streamed)) {
      entriesChars -= last.text.length;
      last.text = text;
      entriesChars += text.length;
    }
  };

  const snapshot = (
    status: "running" | "completed" | "failed" | "cancelled",
    extra?: { error?: string },
  ): ExternalAgentActivityPayload["activity"] => ({
    taskId,
    agentLabel,
    ...(model ? { model } : {}),
    status,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    ...(tail ? { tail } : {}),
    ...(entries.length > 0 ? { entries: entries.map((entry) => ({ ...entry })) } : {}),
    ...(trimmedEntries > 0 ? { trimmedEntries } : {}),
    ...(extra?.error ? { error: extra.error } : {}),
  });

  return {
    started(info) {
      agentLabel = info.label || agentLabel;
      if (info.model) model = info.model;
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
      reconcileFinalText(outcome.text);
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

/**
 * 直接写一条活动状态（不带条目累积）。
 *
 * 用途：后台任务由别的工具（GetExternalAgentTaskResult / CancelExternalAgentTask）
 * 观察到终态时，把卡片从 running 收口到 completed/failed/cancelled。
 * 发起委派的那个工具上下文早已返回，不能再用它的 reporter；这里按任务快照
 * 重建一份最小状态即可（tail 用最终正文尾部，够卡片展示"跑完了"）。
 */
export function publishExternalAgentTaskStatus(
  context: Parameters<ToolHandler>[1],
  input: {
    taskId: string;
    agentLabel: string;
    status: "completed" | "failed" | "cancelled";
    durationMs: number;
    text?: string;
  },
): void {
  if (!context.emitEvent) return;
  const text = input.text?.trim();
  const activity: NonNullable<ExternalAgentActivityPayload["activity"]> = {
    taskId: input.taskId,
    agentLabel: input.agentLabel,
    status: input.status,
    startedAt: Date.now() - input.durationMs,
    elapsedMs: input.durationMs,
    ...(text ? { tail: text.slice(-TAIL_CHARS) } : {}),
  };
  void Promise.resolve(
    context.emitEvent({
      id: crypto.randomUUID(),
      sessionId: context.sessionId,
      turnId: context.turnId,
      type: SessionEventType.ExternalAgentActivityChanged,
      timestamp: new Date(),
      traceId: context.traceId,
      sequenceNumber: 0,
      payload: { activity } satisfies ExternalAgentActivityPayload,
    } as never),
  ).catch(() => undefined);
}
