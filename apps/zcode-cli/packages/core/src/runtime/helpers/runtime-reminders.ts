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
Goal: Design an implementation approach.

**Guidelines:**
- Use the context gathered in Phase 1, including relevant files and code paths.
- Account for the user's requirements and constraints.
- Produce a concrete implementation plan that is detailed enough to execute.
- Consider useful perspectives for the task type:
  - New feature: simplicity vs performance vs maintainability
  - Bug fix: root cause vs workaround vs prevention
  - Refactoring: minimal change vs clean architecture

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${ASK_USER_QUESTION_TOOL_NAME} to clarify any remaining questions with the user

### Phase 4: Call ${EXIT_PLAN_MODE_TOOL_NAME}
At the very end of your turn, once you have asked the user questions and are happy with your final plan - you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${ASK_USER_QUESTION_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons

**Important:** Use ${ASK_USER_QUESTION_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_QUESTION_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`;
}

const PLAN_MODE_FULL_REMINDER = [
  "Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.",
  buildPlanWorkflow(),
];

const PLAN_MODE_SPARSE_REMINDER = [
  `Plan mode still active (see full instructions earlier in conversation). Read-only. Follow 4-phase workflow. End turns with ${ASK_USER_QUESTION_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`,
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

// ZCode 更新模式（zcodeUpdate）：跟进官方发版的 SOP，四阶段固定，逐版本一条台账记录。
// 静态文案。最关键的一条约束：连不通上游时必须停在盘点阶段并
// 明确报「代理未就绪」——拿不到 diff 就不许继续，更不许凭印象描述官方改了什么。
const ZCODE_UPDATE_MODE_FULL_REMINDER = [
  "# ZCode 更新模式 (ZCode Update Mode)",
  "",
  "当前处于 ZCode 更新模式。目标：跟进官方 ZCode 的每个版本，把**与本地二次开发相关**的改动以本地改动的方式落地并验收。本模式持续生效直到用户切换模式；权限等同「完全访问」：命令与文件修改自动执行、不再逐次确认——纪律全靠本指引与台账。破坏性操作（`git reset --hard`、清理未提交改动、强推）执行前仍先向用户说明。",
  "",
  "## 每轮先定位",
  "",
  "1. 读 `zcode-update/更新台账.md`（含机器标记行 `<!-- zcode-update v1 stage:S1 -->`，stage 取 S1/S2/S3/S4）。",
  "2. 有台账 → 从未完成条目续接，不重跑已分析完的版本。",
  "3. 无台账 → 从 S1 开始；S1 的首个产出就是把台账建起来。",
  "4. 回复第一行用【Sx 阶段名】标注当前阶段。",
  "",
  "## S1 盘点（先验连通性，不通就停）",
  "",
  "1. `git ls-remote --tags origin` 验连通。**失败即停**：明确报「代理未就绪」并给出待办（配置 `git config --global http.proxy` 或代理环境变量后重试）。绝不在拿不到 diff 的情况下继续，更不许凭印象描述官方改了什么——那是编造。",
  "2. `git fetch origin --tags` 拉取远端（只更新远端引用，不动工作区）。禁止 `git pull` / `git merge` 官方分支。",
  "3. 列出本地基线到上游之间的版本清单（tag 与提交区间），连同当前 HEAD 一起写进台账。",
  "",
  "## S2 逐版本 diff 分析",
  "",
  "对清单里每个版本：`git diff <prev>..<next> --stat` 先看规模，再按需取全文。按层归类：内置目录/provider 目录、桌面 UI、agent-core、协议枚举、构建与脚本、依赖。逐条判定**相关性**：",
  "- 与本地已改文件是否重叠（重叠即将来 rebase 的冲突源，必须标出来）；",
  "- 是否修了本地也踩过的问题（例如 provider 目录 revision 覆盖、打包缺少必需配置）；",
  "- 是否影响本地已交付的功能（极简上下文档位、极简模式、本模式自身）。",
  "",
  "## S3 落地（重写成本地改动，不直接套用官方提交）",
  "",
  "对判定相关的条目：用本地改动实现，**不 cherry-pick、不 merge**（避免把官方提交历史与冲突带进来）。每条记录「官方改动 → 本地实现方式 → 涉及文件」。判定不相关的条目只记「不相关 + 理由」，不动代码。",
  "",
  "## S4 验收",
  "",
  "跑门禁：`pnpm typecheck`、`pnpm exec oxlint`、`pnpm exec oxfmt --check`、`pnpm architecture:check -- --changed`、相关单测；改动落在 apps/zcode-cli 时另跑 `pnpm --dir apps/zcode-cli check`、`lint`、`format:check`（根 typecheck/lint 不覆盖 CLI）。必要时重新 bundle 并验包内容。逐条勾销台账；门禁不过不许标记完成，也不许用「门禁通过」冒充「功能正确」。",
  "",
  "## 台账与边界",
  "",
  "台账 `zcode-update/更新台账.md`：每个版本一节（版本号 / 提交区间 / 分析结论 / 落地项与文件 / 门禁结果）。",
  "- 只动本次相关文件；不 push；不改与本次无关的代码。",
  "- 上游改动与本地实现冲突且无法判定时上报，不要硬合并——这种取舍需要用户拍板。",
  "- 不伪造分析结论与门禁结果；拿不到 diff 就如实说拿不到。",
];

const ZCODE_UPDATE_MODE_SPARSE_REMINDER = [
  "ZCode 更新模式仍处于激活状态（完整指引见会话前文）：先读 zcode-update/更新台账.md 定位阶段（S1 盘点 / S2 分析 / S3 落地 / S4 验收）；S1 必须先 `git ls-remote` 验连通、失败即停并报「代理未就绪」，不许凭印象编造官方改动；只把相关改动重写成本地补丁，不 merge 官方分支、不 push。",
];

export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

export interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

export function buildDateChangeReminderBody(_previousDate: string, currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. DO NOT mention this to the user explicitly because they are already aware.`;
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

export type RuntimeModeReminderIdentity = "plan" | "research" | "zcodeUpdate";

export interface RuntimeModeReminder {
  body: string;
  identity: RuntimeModeReminderIdentity;
  kind: "full" | "sparse";
}

/**
 * effective identity：Plan 真值优先（plan+research / plan+zcodeUpdate 组合只给 Plan 指引，
 * 否则模型会按「完全访问」行事、每条命令被拒），再 research / zcodeUpdate。
 * 其余模式（含极简）不发模式提醒。
 */
export function resolveRuntimeModeIdentity(
  mode: CollaborationMode,
  planEnabled: boolean,
): RuntimeModeReminderIdentity | null {
  if (planEnabled) return "plan";
  if (mode === "research") return "research";
  if (mode === "zcodeUpdate") return "zcodeUpdate";
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
  const sameActivation = lastReminder?.metadata?.runtimeMode?.identity === identity;
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
  } else if (identity === "zcodeUpdate") {
    body = (full ? ZCODE_UPDATE_MODE_FULL_REMINDER : ZCODE_UPDATE_MODE_SPARSE_REMINDER).join("\n");
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
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "runtime_mode") {
      return { lastReminder: entry, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "user" && entry.metadata?.source === "real_user") {
      humanTurnsSinceReminder++;
    }
  }
  return { humanTurnsSinceReminder };
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
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
  return entries.reduce(
    (count, entry) =>
      count + (entry.metadata?.runtimeMode?.identity === identity ? 1 : 0),
    0,
  );
}
