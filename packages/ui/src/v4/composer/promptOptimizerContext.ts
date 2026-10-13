import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PromptOptimizerContext } from "@/v4/composer/promptOptimizerPrompt.js";

/**
 * 当前会话的**有限**上下文抽取（只读已有窗口，不做 rows/range 回溯）。
 *
 * 取舍理由：指导优化方消解指代需要的是「最近几轮用户原话 + 助手结论」，
 * 不是全量转录。带上工具日志/思考会稀释信号、拉高延迟，还会把未确认的建议
 * 混成事实。窗口不足时宁可标 missing，也不猜一个历史方案。
 *
 * 两条硬边界：
 * - 归属用权威 `productTurnId`（缺席才退 `turnId`），不自行重猜轮次边界；
 * - 只收 realUser 的用户原话与 complete 的助手正文：synthetic / backgroundResult /
 *   goalContinuation / mailbox 等系统来源不是用户需求，不能当依据。
 */

const MAX_CONTEXT_TURNS = 3;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_ENTRY_CHARS = 1_500;

interface ContextEntry {
  turnKey: string;
  label: string;
  text: string;
}

/** 权威轮次键：productTurnId 是产品轮次，不得由 UI 重猜。 */
function turnKeyOf(row: ConversationRow): string {
  return row.productTurnId ?? row.turnId;
}

function userInputEntry(row: Extract<ConversationRow, { kind: "userInput" }>): ContextEntry | null {
  // 系统来源（后台结果/目标续跑/信箱/合成/工作流启动）不是用户原话。
  if (row.origin !== "realUser") {
    return null;
  }
  // text 从 epilogueStart 起是引擎附加文本（尾注/nudge），不是用户原话，必须切掉。
  const visible = row.epilogueStart === undefined ? row.text : row.text.slice(0, row.epilogueStart);
  const text = visible.trim();
  if (!text) {
    return null;
  }
  return {
    turnKey: turnKeyOf(row),
    label: row.guided ? "用户·中途指导" : "用户",
    text,
  };
}

function assistantEntry(
  row: Extract<ConversationRow, { kind: "assistantText" }>,
): ContextEntry | null {
  // 中断/失败/仍在流的正文不是「已给出的结论」，当依据会误导。
  if (row.state !== "complete") {
    return null;
  }
  const text = row.text.trim();
  if (!text) {
    return null;
  }
  return { turnKey: turnKeyOf(row), label: "助手", text };
}

/** 只保留用户原话与已完成助手正文；工具/思考/行级元数据一律不进上下文。 */
function toContextEntry(row: ConversationRow): ContextEntry | null {
  switch (row.kind) {
    case "userInput":
      return userInputEntry(row);
    case "assistantText":
      return assistantEntry(row);
    default:
      return null;
  }
}

/** 最近 N 个权威轮次（窗口本身是最近的，保持出现顺序不重排）。 */
function selectRecentTurnKeys(entries: readonly ContextEntry[]): string[] {
  const keys: string[] = [];
  for (let index = entries.length - 1; index >= 0 && keys.length < MAX_CONTEXT_TURNS; index -= 1) {
    const key = entries[index]!.turnKey;
    if (!keys.includes(key)) {
      keys.unshift(key);
    }
  }
  return keys;
}

export function buildPromptOptimizerContext(
  rows: readonly ConversationRow[],
): PromptOptimizerContext {
  const entries = rows.map(toContextEntry).filter((entry): entry is ContextEntry => entry !== null);
  if (entries.length === 0) {
    return { text: "", truncated: false, missing: true };
  }

  const turnKeys = selectRecentTurnKeys(entries);
  const kept = entries.filter((entry) => turnKeys.includes(entry.turnKey));

  // 预算从**最新**材料开始分配：最新一轮的确认/否定/约束最不能被丢掉，
  // 早先几轮太长时应当先牺牲旧内容。
  let truncated = false;
  const rendered: string[] = [];
  let used = 0;
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const entry = kept[index]!;
    const clipped =
      entry.text.length > MAX_ENTRY_CHARS ? `${entry.text.slice(0, MAX_ENTRY_CHARS)}…` : entry.text;
    if (clipped !== entry.text) {
      truncated = true;
    }
    const line = `[${entry.label}] ${clipped}`;
    if (used + line.length > MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    used += line.length;
    rendered.push(line);
  }
  if (rendered.length < kept.length) {
    truncated = true;
  }
  return { text: rendered.reverse().join("\n"), truncated, missing: false };
}
