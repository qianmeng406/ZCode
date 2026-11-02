/**
 * 输入预测的材料窗口：把会话转录裁成「最近 N 轮」纯文本。
 *
 * 2026-11-02：预测改为独立辅助请求（不再向主轮注入指令），因此需要一份
 * 自足的材料喂给模型。材料只取最近几轮就够——预测下一句输入靠的是
 * 正在做的事和上一条请求，更早的内容对预测没有增益，只增加成本。
 *
 * 轮次语义：一条 user 消息开启新的一轮，其后的 agent 消息属于该轮。
 * 与 `packages/shared/src/session-handoff/prompt.ts` 的 3 轮窗口同义，
 * 但输入是 `SessionTranscriptMessage`（CLI 侧投影）而不是 v4 行。
 */
import type { SessionTranscriptMessage } from "../session-transcript.js";

/** 材料窗口：最近 3 轮（与交接文档一致）。 */
export const INPUT_PREDICTION_MATERIAL_TURNS = 3;
/** 单条消息字符上限：一条粘贴的大日志不应独占整个材料。 */
export const INPUT_PREDICTION_MATERIAL_MESSAGE_CHARS = 1_500;
/** 材料总字符上限：兜底防止多轮长回复把辅助请求撑大。 */
export const INPUT_PREDICTION_MATERIAL_TOTAL_CHARS = 6_000;

export interface RecentTurnsTranscript {
  /** 拼好的材料文本；没有可预测内容时为空串。 */
  text: string;
  /** 材料覆盖的轮数（0 = 没有完整轮次）。 */
  turnCount: number;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/**
 * 取最近 `maxTurns` 轮对话。
 *
 * - user 消息开启新轮；落单的 agent 消息（没有前置 user）不计入轮数；
 * - 每条消息先按 `maxCharsPerMessage` 截断，再按总量上限从**最新往前**保留；
 * - 返回的 `turnCount` 是实际进入材料的轮数，调用方据此判断上下文是否足够。
 */
export function buildRecentTurnsTranscript(
  transcript: readonly SessionTranscriptMessage[],
  options: {
    maxTurns?: number;
    maxCharsPerMessage?: number;
    maxTotalChars?: number;
  } = {},
): RecentTurnsTranscript {
  const maxTurns = options.maxTurns ?? INPUT_PREDICTION_MATERIAL_TURNS;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? INPUT_PREDICTION_MATERIAL_MESSAGE_CHARS;
  const maxTotalChars = options.maxTotalChars ?? INPUT_PREDICTION_MATERIAL_TOTAL_CHARS;

  // 1) 按 user 消息切轮，保留轮号以便后面取尾部。
  const turns: Array<{ index: number; lines: string[] }> = [];
  for (const message of transcript) {
    const body = clip(message.content, maxCharsPerMessage);
    if (!body) continue;
    if (message.role === "user") {
      turns.push({ index: turns.length, lines: [`### 用户\n${body}`] });
      continue;
    }
    const current = turns[turns.length - 1];
    // 落单的 agent 消息（会话开头没有 user）不构成一轮，直接丢弃：
    // 预测需要「用户说了什么 → 助手回了什么」的完整对照。
    if (!current) continue;
    current.lines.push(`### 助手\n${body}`);
  }

  const windowed = turns.slice(-maxTurns);
  if (windowed.length === 0) return { text: "", turnCount: 0 };

  // 2) 从最新往前累加：超总量就停止，并把省略掉的轮数记下来写进材料。
  const kept: string[] = [];
  let used = 0;
  let omittedTurns = 0;
  for (let index = windowed.length - 1; index >= 0; index -= 1) {
    const block = windowed[index]!.lines.join("\n\n");
    // 最新一轮即使本身超限也必须保留（只保留它的截断结果），否则材料为空。
    if (kept.length > 0 && used + block.length > maxTotalChars) {
      omittedTurns = index + 1;
      break;
    }
    kept.unshift(block);
    used += block.length;
    // 最新一轮超限：直接计入省略的其余轮次。
    if (used > maxTotalChars && index > 0) {
      omittedTurns = index;
      break;
    }
  }

  const prefix = omittedTurns > 0 ? ["[... 最近 3 轮内的更早内容已省略 ...]", ""] : [];
  return {
    text: [...prefix, ...kept].join("\n\n"),
    turnCount: kept.length,
  };
}
