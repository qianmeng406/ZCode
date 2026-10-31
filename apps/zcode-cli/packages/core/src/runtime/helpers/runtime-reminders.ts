import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "../../subagent/explore.js";
import { isUserTurnInput } from "./provider-entry-origins.js";

export const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

const planResearchAgentCount = 3;

function buildPlanWorkflow() {
  return `## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${EXPLORE_AGENT_TYPE} subagent type.

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused \u2014 avoid proposing new code when suitable implementations already exist.

2. **Launch up to ${planResearchAgentCount} ${EXPLORE_AGENT_TYPE} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${planResearchAgentCount} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

### Phase 2: Design
Goal: Design an implementation approach based on the user's intent and your exploration results from Phase 1.

- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Produce a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files you identified during exploration to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Prepare your complete final plan for the \`plan\` parameter of ${EXIT_PLAN_MODE_TOOL_NAME}.
- Begin with a **Context** section: explain why this change is being made \u2014 the problem or need it addresses, what prompted it, and the intended outcome
- Include only your recommended approach, not all alternatives
- Ensure that the final plan is concise enough to scan quickly, but detailed enough to execute effectively
- Name the critical files to be modified. For changes that repeat a pattern across many files, describe the pattern once and list a few representative paths \u2014 do not enumerate every file or line number
- Reference existing functions and utilities you found that should be reused, with their file paths
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call ${EXIT_PLAN_MODE_TOOL_NAME}
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning. When calling ${EXIT_PLAN_MODE_TOOL_NAME}, pass the complete final plan in its \`plan\` parameter.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

const PLAN_MODE_FULL_REMINDER = [
  "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.",
  buildPlanWorkflow(),
];

const PLAN_MODE_SPARSE_REMINDER = [
  `Plan mode still active (see full instructions earlier in conversation). Read-only. Follow 5-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
];

const PLAN_MODE_EXIT_REMINDER = [
  "## Exited Plan Mode",
  "",
  `You have exited plan mode. You can now make edits, run tools, and take actions.`,
];

// 资料查询模式（research mode）：中文检索引导。渠道工具与提示词成对维护——
// 表里提到的工具都必须真实注册（tool/handlers/research-tools.ts），否则模型会调用不存在的工具。
const RESEARCH_MODE_FULL_REMINDER = [
  "# 资料查询模式 (Research Mode)",
  "",
  "当前处于资料查询模式。你的任务是根据用户的问题检索资料、阅读原文并给出有依据的回答，而不是修改代码或执行工程任务。本模式下执行命令、修改文件的操作会被拒绝。",
  "",
  "## 检索渠道（本模式专属工具）",
  "",
  "按问题类型选择渠道，多渠道并行检索、相互印证：",
  "",
  "| 问题类型 | 首选渠道 | 说明 |",
  "|---|---|---|",
  "| 库/框架/工具的用法 | `SearchDocs` → `GetLibraryDocs` | Context7 官方文档检索，先搜库再读文档 |",
  "| Web/JS/HTML/CSS 标准 API | `SearchMdn` | MDN Web Docs，浏览器厂商维护的权威参考 |",
  "| 具体编程问题/报错 | `SearchStackOverflow` | Stack Overflow；`site` 参数可搜整个 Stack Exchange 网络（math/stats/superuser/ai…） |",
  "| 选 npm 包 / Node、前端生态 | `SearchNpm` | 带月下载量、依赖者数、版本 |",
  "| 确认 Python 包信息 | `SearchPyPI` | PyPI 精确查询（版本、支持的 Python、主页） |",
  "| 找项目/实现/工具 | `SearchGitHub` | GitHub 仓库搜索（可比较热度） |",
  "| 技术选型/业界动态/社区观点 | `SearchHackerNews` | Hacker News 讨论 |",
  "| 算法/模型/CS 预印本 | `SearchArxiv` | arXiv 论文 |",
  "| 跨学科文献（含引用数、期刊） | `SearchPapers` | OpenAlex 索引，覆盖所有学科 |",
  "| 医学/生物/药学/临床 | `SearchPubmed` | PubMed 生物医学文献 |",
  "| 通用网页信息/新闻/中文资料 | `WebSearch`（内置） | 联网搜索 |",
  "",
  "找到有价值的链接后，用 `WebFetch`（内置）或 `GetLibraryDocs` 抓取原文精读。",
  "",
  "## 工作流程",
  "",
  "1. **拆解问题**：先把用户的问题拆成几个具体的检索点；问题模糊时先向用户确认检索范围，再开始搜索。",
  "2. **多路检索**：对每个检索点选择合适渠道，用不同关键词多搜几轮，不要只依赖第一次搜索的结果；独立的检索可以并行发起。",
  "3. **阅读原文**：对最有价值的结果抓取原文精读（文档用 `GetLibraryDocs`，网页用 `WebFetch`），不要只根据摘要或片段下结论。",
  "4. **交叉验证**：重要结论至少用两个独立来源印证；来源之间冲突时如实说明分歧，并指出哪一方更可信、为什么。",
  "5. **带引用作答**：最终回答中为关键事实标注来源链接；不确定的内容明确说「未找到可靠来源」，不要编造。",
  "",
  "## 边界",
  "",
  "- 本模式下不要执行命令、修改文件或进行代码工程类操作；用户明确要求时，提醒其先切换到其他模式。",
  "- 回答使用用户提问的语言；引用保留原文表述。",
];

const RESEARCH_MODE_SPARSE_REMINDER = [
  "资料查询模式仍处于激活状态（完整指引见会话前文）。只读检索：用渠道工具多路检索并交叉验证，关键结论标注来源链接；不要尝试执行命令或修改文件。",
];

export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

const SILENT_TURN_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_REMINDERS: 5,
  MAX_REMINDERS_PER_STRETCH: 3,
});
const SILENT_TURN_REMINDER_BODY =
  "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.";
// 只有空白或这些占位文字的 assistant 文本不算与用户沟通。
const SILENT_TURN_PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set([
  "(no content)",
  "No response requested.",
]);

function isVisibleAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !SILENT_TURN_PLACEHOLDER_TEXTS.has(trimmed);
}

export function buildSilentTurnReminderBody(
  entries: readonly RuntimeMessageEntry[],
): string | null {
  let silentTurns = 0;
  let reminders = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "silent_turn_reminder") {
      reminders++;
      if (reminders >= SILENT_TURN_REMINDER_CONFIG.MAX_REMINDERS_PER_STRETCH) return null;
      continue;
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    const { message } = entry;
    // 新的用户轮次结束静默段：新轮通知、中断标记与 compact summary 也算。
    // 中途输入（user_steer 等，含旧版本存下的立即发送）不算，不结束静默段。
    if (isUserTurnInput(entry)) break;
    if (message.role !== "assistant") continue;
    const communicated =
      typeof message.content === "string"
        ? isVisibleAssistantText(message.content)
        : message.content.some(
            (block) => block.type === "text" && isVisibleAssistantText(block.text),
          );
    if (
      communicated ||
      message.toolCalls?.some(
        (call) =>
          call.name === ASK_USER_QUESTION_TOOL_NAME || call.name === EXIT_PLAN_MODE_TOOL_NAME,
      )
    )
      break;
    // 每个已提交 assistant entry 是一次模型响应；工具数量和工具结果都不增加轮次。
    // 只累计最新提醒之后的响应，历史提醒仍用于限制同一段静默中的重复次数。
    if (reminders === 0) silentTurns++;
  }
  return silentTurns >= SILENT_TURN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
    ? SILENT_TURN_REMINDER_BODY
    : null;
}

export interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

export function buildDateChangeReminderBody(currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. No need to announce the new date — the user's own clock shows it.`;
}

export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "agent_listing_delta") {
    return systemReminderRuntimeMetadata(source);
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "bot_topic_context") return systemReminderRuntimeMetadata("bot_topic_context");
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

export function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;
    // 思考块会单独进入历史；只跳过纯思考，避免提前触发提醒，也不漏计带工具调用的消息。
    if (
      Array.isArray(entry.message.content) &&
      entry.message.content.every((block) => block.type === "reasoning") &&
      !entry.message.toolCalls?.length
    ) {
      continue;
    }

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
    "",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "Here are the existing contents of your todo list:", "", currentTodos);
  }
  return lines.join("\n");
}

export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
  options: { pendingFull?: boolean } = {},
): string | null {
  return buildRuntimeModeReminder(entries, mode, planEnabled, options)?.body ?? null;
}

export type RuntimeModeReminderIdentity = "plan" | "research";

export interface RuntimeModeReminder {
  body: string;
  identity: RuntimeModeReminderIdentity;
  kind: "full" | "sparse";
}

/**
 * effective identity：Plan 真值优先（plan+research 组合只给 Plan 指引，
 * 否则模型会按「完全访问」行事、每条命令被拒），再 research。
 * zcodeUpdate（ZCode 更新模式）已移除，不再产生模式提醒。
 * 其余模式（含极简）不发模式提醒。
 */
export function resolveRuntimeModeIdentity(
  mode: CollaborationMode,
  planEnabled: boolean,
): RuntimeModeReminderIdentity | null {
  if (planEnabled) return "plan";
  if (mode === "research") return "research";
  return null;
}

/**
 * 构造当前模式提醒并返回结构化身份，供调用方给 attachment 打 runtimeMode 标记。
 *
 * 节流按「同一身份 activation」计算：模式进入与重新进入（pendingFull）总是全文；
 * 同一 activation 内按真实人类轮数节流、周期全文只统计当前身份。旧条目没有身份标记，
 * 按未知身份处理——不能拿别的模式的节流压掉本次进入的全文（实测问题）。
 */
export function buildRuntimeModeReminder(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
  options: { pendingFull?: boolean } = {},
): RuntimeModeReminder | null {
  const identity = resolveRuntimeModeIdentity(mode, planEnabled);
  if (!identity) return null;

  const { lastReminder, humanTurnsSinceReminder } = getRuntimeModeReminderState(entries);
  // 旧条目没有身份标记：按当前身份处理（历史兼容），有标记时才区分 activation。
  const sameActivation =
    lastReminder !== undefined &&
    (lastReminder.metadata?.runtimeMode?.identity ?? identity) === identity;
  if (
    sameActivation &&
    !options.pendingFull &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  const nextReminderCount = countRuntimeModeReminders(entries, identity) + 1;
  const kind: "full" | "sparse" =
    options.pendingFull ||
    nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1
      ? "full"
      : "sparse";
  const full = kind === "full";
  let body: string;
  if (identity === "research") {
    body = (full ? RESEARCH_MODE_FULL_REMINDER : RESEARCH_MODE_SPARSE_REMINDER).join("\n");
  } else {
    body = (full ? PLAN_MODE_FULL_REMINDER : PLAN_MODE_SPARSE_REMINDER).join("\n");
  }
  return { body, identity, kind };
}

function getRuntimeModeReminderState(entries: readonly RuntimeMessageEntry[]): {
  lastReminder?: RuntimeMessageEntry;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  // 修复原因：轮首收集时本轮 prompt 已在历史里，直接计入会让提醒比应有的早一轮。
  // 本轮 prompt 在模型回应之前不计入，工具批次之后的收集才计入。
  let skipUnansweredPrompt = true;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    // 退出前的间隔不属于新一段计划模式，否则立即重进会缺失完整提醒。
    if (entry.metadata?.source === "plan_mode_exit") break;
    if (entry.metadata?.source === "runtime_mode") {
      return { lastReminder: entry, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "assistant") skipUnansweredPrompt = false;
    // 修复原因：中途 steer 也带 real_user 来源，算成用户轮次会让提醒发得过早；
    // 中途输入不计入。新轮通知、中断标记与 compact summary 计入，与静默段同一判定。
    if (isUserTurnInput(entry)) {
      if (skipUnansweredPrompt) skipUnansweredPrompt = false;
      else humanTurnsSinceReminder++;
    }
  }
  return { humanTurnsSinceReminder };
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

/** 当前计划段（最近一次退出之后）里是否已有完整的 plan 提醒。 */
export function hasFullRuntimeModeReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "plan_mode_exit") return false;
    if (
      isRuntimeAttachmentEntry(entry) &&
      entry.metadata.source === "runtime_mode" &&
      entry.content.startsWith(PLAN_MODE_FULL_REMINDER[0]!)
    ) {
      return true;
    }
  }
  return false;
}

export const OUTPUT_STYLE_RESET_REMINDER =
  "The output style was reset to the default. Respond in your usual style.";

/** output style 指令正文；prompt 为空白时视为未设置。 */
export function buildOutputStyleInstructionsBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) return null;
  return `# Output Style: ${outputStyle.name}\n${activePrompt}`;
}

export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`;
}

function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

/** 周期全文只统计当前身份的提醒；旧条目无身份标记不参与（避免跨模式混算）。 */
function countRuntimeModeReminders(
  entries: readonly RuntimeMessageEntry[],
  identity: RuntimeModeReminderIdentity,
): number {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const metadata = entries[index]!.metadata;
    // 完整／简短周期也必须在同一个退出边界重置，不能沿用旧周期。
    if (metadata?.source === "plan_mode_exit") break;
    // 旧条目没有身份标记：按当前身份处理，不能因缺标记把周期计数清零。
    if (metadata?.source === "runtime_mode" && (metadata.runtimeMode?.identity ?? identity) === identity)
      count++;
  }
  return count;
}
