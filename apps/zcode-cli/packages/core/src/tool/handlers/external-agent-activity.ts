// 外部 agent 的活动卡数据源：把执行进度收敛成一条会话状态事件。
//
// 为什么不用工具行：后台任务的工具行几百毫秒就结算了，而外部 agent 可能还在跑十几
// 分钟。用户要的是一张**一直可见**的卡：「谁在跑 / 跑了多久 / 最近在做什么」。
//
// 设计要点：
// - **全量首帧 + 增量帧**（2026-11-05）：首帧/收口/裁剪时发完整快照，执行中只发
//   `baseRevision + entriesFrom + entries 片段`。原先每 300ms 发整份快照，一次长
//   委派会往事件流里塞十几 MB 重复内容，还得靠 24k 字符上限裁剪历史；增量帧让
//   上限只约束"当前展示窗口"，历史随 stdout artifact 一起落盘。
// - 开始/结束各发一次，执行中按节流发（300ms），避免事件风暴；
// - 发送永不阻塞执行（进度丢了不影响任务本身）。
import { SessionEventType, type ExternalAgentActivityPayload } from "@zcode/contracts";
import type { ToolHandler } from "../types.js";

const TAIL_CHARS = 2_000;
const THROTTLE_MS = 300;
/** 任务正文进快照的长度上限：面板要显示"主 agent 发了什么"，但不能撑爆快照。 */
const MAX_PROMPT_CHARS = 20_000;
// 上限只约束"当前累积的展示窗口"：增量帧下每个事件只带新增片段，事件流大小
// 与真实输出成正比，不再需要小上限来压快照体积。
const MAX_ENTRIES = 1_000;
const MAX_ENTRY_CHARS = 200_000;

interface ActivityEntry {
  kind: "reasoning" | "text" | "tool";
  text: string;
}

export interface ExternalAgentActivityReporter {
  /** 绑定读到时调用：卡片立即出现（running，0ms）。`prompt` 是实际发给 CLI 的任务正文。 */
  started(info: { label: string; model?: string; prompt?: string }): void;
  /**
   * 执行中的输出：节流更新 tail。
   *
   * 收口权威重建有两种调用形状，**都必须支持**：
   * - driver 的 onOutput：`{ entries, replace: true }`（bootstrap 直接透传）；
   * - reporter 自己的测试/调用方：`{ replaceEntries }`。
   *
   * 曾经只认后者、而 driver 发前者，于是"权威重建"被当成普通增量追加，
   * 同一段结论在面板里出现两遍（2026-11-06 实测）。
   */
  progress(chunk: {
    text?: string;
    preview?: unknown;
    entries?: ActivityEntry[];
    /** driver 形状：true = entries 是收口后的权威重建，整体替换。 */
    replace?: boolean;
    replaceEntries?: ActivityEntry[];
    /** 源输出被截断（artifact 超重解析上限）：粘性标记，之后每帧都带上。 */
    sourceTruncated?: boolean;
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
  let model: string | undefined;
  // 主 agent 实际发给 CLI 的任务正文：面板把它渲染成第一条「用户消息」。
  let prompt: string | undefined;
  let tail = "";
  let entries: ActivityEntry[] = [];
  let entriesChars = 0;
  let lastEmitAt = 0;
  let finished = false;
  // 因超出上限被裁掉的条目数：面板用它在顶部提示「更早过程已折叠」，
  // 否则长任务的开头被静默裁掉，用户只会觉得"内容不全"。
  let trimmedEntries = 0;
  // 源输出被截断（artifact > 32MB）：与 trimmedEntries 不同，这是源数据不全，
  // 面板要区分「我们折叠了」和「本来就没解析到」。
  let sourceTruncated = false;

  // 增量帧状态：上一次成功 emit 的版本、条目数与最后一条正文（合并会改写它）。
  let revision = 0;
  let emittedRevision = 0;
  let emittedEntryCount = 0;
  let emittedTrimmed = 0;
  let emittedLastText: string | undefined;

  const emit = (
    status: "running" | "completed" | "failed" | "cancelled",
    opts: { error?: string; force?: boolean; full?: boolean } = {},
  ): void => {
    if (!context.emitEvent) return;
    const now = Date.now();
    if (!opts.force && now - lastEmitAt < THROTTLE_MS) return;
    lastEmitAt = now;
    revision += 1;
    // 能发增量帧的条件：已有基线、没裁剪过（裁剪会让索引失效）、没被要求全量。
    const canDelta =
      !opts.full &&
      emittedRevision > 0 &&
      emittedTrimmed === trimmedEntries &&
      entries.length >= emittedEntryCount;
    let entriesFrom = emittedEntryCount;
    // 相邻同类正文会合并进上一条：把被改写的最后一条一起重发，否则接收方
    // 永远停在旧文本上（文本增量帧最容易踩的坑）。
    if (canDelta && entriesFrom > 0 && entries[entriesFrom - 1]?.text !== emittedLastText) {
      entriesFrom -= 1;
    }
    const activity: NonNullable<ExternalAgentActivityPayload["activity"]> = {
      taskId,
      agentLabel,
      ...(model ? { model } : {}),
      // 任务正文只随全量帧下发：它每帧都一样，增量帧重复带上会把事件日志
      // 按帧数放大（一次 10 分钟委派 ≈ 200 帧）。接收方靠 mergeActivityDelta
      // 保留上一次的值。
      ...(prompt && !canDelta ? { prompt } : {}),
      status,
      startedAt,
      elapsedMs: now - startedAt,
      ...(tail ? { tail } : {}),
      ...(trimmedEntries > 0 ? { trimmedEntries } : {}),
      ...(sourceTruncated ? { sourceTruncated: true } : {}),
      revision,
      ...(canDelta
        ? {
            baseRevision: emittedRevision,
            entriesFrom,
            ...(entries.length > entriesFrom
              ? { entries: entries.slice(entriesFrom).map((entry) => ({ ...entry })) }
              : {}),
          }
        : {
            ...(entries.length > 0 ? { entries: entries.map((entry) => ({ ...entry })) } : {}),
          }),
      ...(opts.error ? { error: opts.error } : {}),
    };
    emittedRevision = revision;
    emittedEntryCount = entries.length;
    emittedTrimmed = trimmedEntries;
    emittedLastText = entries.at(-1)?.text;
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

  /** 超出上限时从最老开始裁；裁掉多少要在面板上说明（trimmedEntries）。 */
  const trimEntries = () => {
    while (entries.length > MAX_ENTRIES || entriesChars > MAX_ENTRY_CHARS) {
      const dropped = entries.shift();
      if (!dropped) break;
      entriesChars -= dropped.text.length;
      trimmedEntries += 1;
    }
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
    trimEntries();
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

  /** 显式清空（解绑/切换会话）：payload.activity = null。 */
  const emitCleared = (): void => {
    if (!context.emitEvent) return;
    lastEmitAt = Date.now();
    void Promise.resolve(
      context.emitEvent({
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ExternalAgentActivityChanged,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: { activity: null } satisfies ExternalAgentActivityPayload,
      } as never),
    ).catch(() => undefined);
  };

  return {
    started(info) {
      agentLabel = info.label || agentLabel;
      if (info.model) model = info.model;
      if (info.prompt?.trim()) {
        prompt =
          info.prompt.length > MAX_PROMPT_CHARS
            ? `${info.prompt.slice(0, MAX_PROMPT_CHARS)}…`
            : info.prompt;
      }
      emit("running", { force: true, full: true });
    },
    progress(chunk) {
      if (finished) return;
      // 统一替换语义：driver 用 `replace: true`，内部调用方用 `replaceEntries`。
      // 两者都是"整体替换"，绝不能落进下面的 append 分支（那会让正文出现两遍）。
      const replacement = chunk.replaceEntries ?? (chunk.replace ? chunk.entries : undefined);
      if (chunk.sourceTruncated) {
        sourceTruncated = true;
        // 只有标记、没有内容：也要发一帧，否则这条提示要等下一次输出才生效
        // （最后一帧可能就是收口帧，但中途静默时用户不该等）。
        if (
          !chunk.entries?.length &&
          !replacement?.length &&
          !chunk.text &&
          !previewText(chunk.preview)
        ) {
          emit("running");
          return;
        }
      }
      if (replacement) {
        // 收口权威重建：来自全量 stdout 的重解析，整体替换执行中靠尾窗差分
        // 拼出来的条目（那些可能重复/丢段）。替换后重新计裁剪数。
        entries = replacement.map((entry) => ({ ...entry }));
        entriesChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
        trimmedEntries = 0;
        trimEntries();
        emit("running", { force: true, full: true });
        return;
      }
      if (chunk.entries?.length) {
        appendEntries(chunk.entries);
        emit("running");
        return;
      }
      const text = chunk.text || previewText(chunk.preview);
      if (text) tail = (tail + text).slice(-TAIL_CHARS);
      if (!text) return;
      emit("running");
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
      // 终态发全量帧：即使执行中有增量帧丢失/被节流，客户端也能一次收敛。
      emit(status, { force: true, full: true, ...(error ? { error } : {}) });
    },
    clear() {
      finished = true;
      emitCleared();
    },
  };
}

/**
 * 直接写一条活动状态（不带条目累积）。
 *
 * 用途：后台任务由别的工具（GetExternalAgentTaskResult / CancelExternalAgentTask）
 * 观察到终态时，把卡片从 running 收口到 completed/failed/cancelled。
 * 发起委派的那个工具上下文早已返回，不能再用它的 reporter；这里按任务快照
 * 重建一份最小状态即可。
 *
 * 有最终正文时**以结构化 text 条目下发**（而不是只塞 tail）：面板对条目走
 * markdown 渲染，tail 只用于没有结构的原始输出兜底。仍然只发一条，投影侧的
 * "瘦快照不覆盖富记录"守卫照旧生效（条目数不超过 previous 才视为瘦）。
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
    ...(text
      ? {
          tail: text.slice(-TAIL_CHARS),
          entries: [{ kind: "text" as const, text }],
        }
      : {}),
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
