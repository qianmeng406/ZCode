import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * 审查材料的组装层（纯函数，node:test 可直测）。
 *
 * 之前的审查上下文只有「header 前最近一条真实用户输入」；对话审查要求把**目标轮次
 * 的完整材料**（该轮全部用户输入、助手可见正文、工具调用与终态结果）交给审查方。
 * 轮次归属以行上权威标签为准（productTurnId → turnId → 位置兜底），不按
 * 「header 到下一个 header」自行切片；窗口是尾部连续窗口，翻页兜底复用
 * rows/range 游标（与 conversationShareService.loadAllRows 同规则：推进校验 +
 * 预算上限）。
 */

/** 手动审查接受的轮次终态：失败/被中断的轮次本身是被审查对象，不等于审查失败。 */
export type OracleReviewableTurnState = "completedSuccess" | "completedInterrupted" | "failed";

export function isOracleReviewableTurnState(state: string): state is OracleReviewableTurnState {
  return (
    state === "completedSuccess" || state === "completedInterrupted" || state === "failed"
  );
}

/** 目标轮次的稳定身份：entityId 是持久实体定位，rowId 仅作诊断与陈旧校验。 */
export interface OracleReviewTargetRef {
  rowId: number;
  entityId: string;
  productTurnId?: string;
}

/** 轮次归属所需的最小 header 引用（发起时可从锁定的请求直接构造）。 */
export interface OracleTurnHeaderRef {
  rowId: number;
  turnId?: string;
  productTurnId?: string;
}

export interface OracleUserInputEntry {
  rowId: number;
  text: string;
  /** origin 原样保留：后台结果不冒充用户指令，审查方据标签区分权重。 */
  origin: string;
  /**
   * 中途指导（turn-steer）：CLI 写入 origin:"realUser"+guided:true（协议 origin 闭集
   * 无 guided）。必须单独标记，否则指导文本会以「用户」标签冒充主请求。
   */
  guided?: boolean;
  /** 引擎附加文本下标（epilogue 不属于用户原话；0 = 整条都是引擎文本）。 */
  epilogueStart?: number;
}

/** 用户可见正文：从 text 截到 epilogue 起点（0 → 空串，整条是引擎文本）。 */
export function visibleUserInputText(text: string, epilogueStart?: number): string {
  if (epilogueStart === undefined) return text;
  return text.slice(0, Math.max(0, epilogueStart));
}

export interface OracleAssistantTextEntry {
  rowId: number;
  text: string;
  model?: string;
}

export interface OracleToolCallEntry {
  rowId: number;
  toolCallId: string;
  toolName: string;
  status: string;
  inputText: string;
  /** 终态输出正文（可能被协议层截断，truncated 标记）。 */
  outputText?: string;
  outputTruncated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** 单个轮次的审查材料。 */
export interface OracleTurnMaterial {
  headerRowId: number;
  productTurnId?: string;
  userInputs: OracleUserInputEntry[];
  assistantTexts: OracleAssistantTextEntry[];
  toolCalls: OracleToolCallEntry[];
  /** 行取数不完整（翻页预算耗尽/轮次起点未找到）：如实标注，不称完整审查。 */
  truncated: boolean;
}

export interface OracleTurnMaterialCompleteness {
  truncatedRows: boolean;
  /**
   * 取数不完整的具体原因：budget=翻页预算耗尽；exhausted=翻到历史最早仍未找到起点；
   * fetch-failed=取数查询抛错；no-window=会话行窗口为空；log-rewritten=翻页期间
   * 日志水位变化（rewind/压缩）。完整时为 null。文案按原因分别陈述，不统一归因。
   */
  rowsIncompleteReason:
    | "budget"
    | "exhausted"
    | "fetch-failed"
    | "no-window"
    | "log-rewritten"
    | null;
  toolOutputsTruncated: number;
  /** 仍未找到轮次起点（turnHeader）时为 true：材料按「窗口内该轮可见行」组装。 */
  turnStartMissing: boolean;
}

export interface OracleTurnMaterialBundle {
  material: OracleTurnMaterial;
  completeness: OracleTurnMaterialCompleteness;
}

/** rows/range 翻页的最小结构面（调用方从 agentService 注入，保持纯函数可测）。 */
export type OracleMaterialFetchRowsBefore = (
  beforeRowId: number,
  limit: number,
) => Promise<{
  rows: readonly ConversationRow[];
  hasMore: boolean;
  /** 读水位（协议 rows/range 的 atLogEpoch/atRevision）：翻页期间变化即日志重写。 */
  atLogEpoch?: string;
  atRevision?: number;
}>;

const MATERIAL_PAGE_SIZE = 200;
const MATERIAL_MAX_PAGES = 10;

function belongsToTurn(
  row: ConversationRow,
  header: OracleTurnHeaderRef,
): boolean {
  // 权威归属三级退化：productTurnId（新 CLI 必带）→ turnId → 位置（同窗口内
  // header 及其后、直到下一个 turnHeader）。行上的 turn 标签是 CLI 裁决的事实，
  // 客户端只在标签缺席时才用位置推断。
  if (header.productTurnId && row.productTurnId) {
    return row.productTurnId === header.productTurnId;
  }
  if (row.turnId && header.turnId) {
    return row.turnId === header.turnId;
  }
  if (row.kind === "turnHeader") {
    return row.rowId === header.rowId;
  }
  return row.rowId > header.rowId;
}

/** 在行集合里按 rowId 找 turnHeader（rowId + entityId 双命中才算权威命中）。 */
export function findTurnHeaderByRef(
  rows: readonly ConversationRow[],
  ref: Pick<OracleReviewTargetRef, "rowId" | "entityId">,
): TurnHeaderRow | null {
  for (const row of rows) {
    if (row.kind === "turnHeader" && row.rowId === ref.rowId && row.entityId === ref.entityId) {
      return row;
    }
  }
  return null;
}

/**
 * 从一段连续行窗口里切出目标轮次的行（含窗口外的「轮次起点缺失」判断）。
 * 返回的行按 rowId 升序，不含 turnHeader 行本身（header 不是正文材料）。
 * 位置兜底模式有「下一个 turnHeader 截止」边界，防止把后续轮次的行吞进来。
 */
export function collectTurnRowsFromWindow(
  windowRows: readonly ConversationRow[],
  header: OracleTurnHeaderRef,
): { rows: ConversationRow[]; turnStartMissing: boolean } {
  const rows: ConversationRow[] = [];
  let sawHeader = false;
  let sawHeaderInWindow = false;
  // 位置兜底的截止点：目标 header 之后遇到的第一个 turnHeader。
  let positionalStopAtRowId: number | null = null;
  for (const row of windowRows) {
    if (row.kind === "turnHeader") {
      if (row.rowId === header.rowId) {
        sawHeader = true;
        sawHeaderInWindow = true;
        continue;
      }
      if (
        sawHeader &&
        !header.productTurnId &&
        !header.turnId &&
        positionalStopAtRowId === null
      ) {
        positionalStopAtRowId = row.rowId;
      }
      continue;
    }
    if (positionalStopAtRowId !== null && row.rowId >= positionalStopAtRowId) {
      continue;
    }
    if (belongsToTurn(row, header)) {
      rows.push(row);
    }
  }
  return { rows, turnStartMissing: !sawHeaderInWindow };
}

function materialFromRows(
  header: OracleTurnHeaderRef,
  rows: readonly ConversationRow[],
  completeness: OracleTurnMaterialCompleteness,
): OracleTurnMaterialBundle {
  const material: OracleTurnMaterial = {
    headerRowId: header.rowId,
    ...(header.productTurnId ? { productTurnId: header.productTurnId } : {}),
    userInputs: [],
    assistantTexts: [],
    toolCalls: [],
    truncated: completeness.truncatedRows || completeness.turnStartMissing,
  };
  for (const row of rows) {
    if (row.kind === "userInput") {
      material.userInputs.push({
        rowId: row.rowId,
        text: row.text,
        origin: row.origin,
        ...(row.guided ? { guided: true } : {}),
        ...(row.epilogueStart !== undefined ? { epilogueStart: row.epilogueStart } : {}),
      });
    } else if (row.kind === "assistantText") {
      material.assistantTexts.push({
        rowId: row.rowId,
        text: row.text,
        ...(row.model ? { model: row.model } : {}),
      });
    } else if (row.kind === "toolCall") {
      material.toolCalls.push({
        rowId: row.rowId,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        status: row.status,
        inputText: row.inputText,
        ...(row.output?.text ? { outputText: row.output.text } : {}),
        ...(row.output?.truncated ? { outputTruncated: true } : {}),
        ...(row.error ? { errorCode: row.error.code, errorMessage: row.error.message } : {}),
      });
      if (row.output?.truncated) {
        completeness.toolOutputsTruncated += 1;
      }
    }
    // reasoning 不进材料（不是对用户的陈述，也不是执行证据）；artifact/subagent/hook
    // 等行只保留在 toolCalls/inputText 已覆盖的范围，缺失在 completeness 里如实说明。
  }
  return { material, completeness };
}

/**
 * 组装目标轮次的完整材料：窗口直取，轮次起点不在窗口（或窗口不含全部行）时用
 * rows/range 游标向前翻页补齐，直到找到 header 行或预算耗尽。翻页遵守两条取数
 * 纪律：① 游标必须推进（未推进即日志重写，停止并标注）；② 每页读水位
 * （atLogEpoch/atRevision）对账，翻页期间水位变化即 rewind/压缩 —— 停止并标注，
 * 不把两个 journal 状态的行拼成「完整材料」。翻页行与窗口行合并后统一走
 * collectTurnRowsFromWindow 的边界规则切轮。
 */
export async function assembleOracleTurnMaterial(params: {
  windowRows: readonly ConversationRow[];
  header: OracleTurnHeaderRef;
  fetchRowsBefore: OracleMaterialFetchRowsBefore;
  maxPages?: number;
}): Promise<OracleTurnMaterialBundle> {
  const { windowRows, header } = params;
  const maxPages = params.maxPages ?? MATERIAL_MAX_PAGES;
  const headerInWindow = windowRows.some(
    (row) => row.kind === "turnHeader" && row.rowId === header.rowId,
  );
  if (headerInWindow) {
    // 窗口是连续尾部：header 命中即权威，目标轮的行必然都在窗口里。
    const cut = collectTurnRowsFromWindow(windowRows, header);
    return materialFromRows(header, cut.rows, {
      truncatedRows: false,
      rowsIncompleteReason: null,
      toolOutputsTruncated: 0,
      turnStartMissing: false,
    });
  }
  // 轮次起点不在窗口：向后翻页补历史（原始行整体并入，最后统一切轮）。
  const merged = new Map<number, ConversationRow>();
  for (const row of windowRows) merged.set(row.rowId, row);
  const earliestWindowRowId = windowRows[0]?.rowId;
  let rowsIncompleteReason: OracleTurnMaterialCompleteness["rowsIncompleteReason"] = null;
  let turnStartMissing = true;
  let firstLogEpoch: string | undefined;
  if (earliestWindowRowId === undefined) {
    rowsIncompleteReason = "no-window";
  } else {
    let beforeRowId = earliestWindowRowId;
    for (let page = 0; page < maxPages; page += 1) {
      let result: Awaited<ReturnType<OracleMaterialFetchRowsBefore>>;
      try {
        result = await params.fetchRowsBefore(beforeRowId, MATERIAL_PAGE_SIZE);
      } catch {
        rowsIncompleteReason = "fetch-failed";
        break;
      }
      // 读水位对账：首屏记录，后续页不一致即日志被重写，停止拼接。
      if (result.atLogEpoch !== undefined) {
        if (firstLogEpoch === undefined) {
          firstLogEpoch = result.atLogEpoch;
        } else if (result.atLogEpoch !== firstLogEpoch) {
          rowsIncompleteReason = "log-rewritten";
          break;
        }
      }
      for (const row of result.rows) {
        if (row.rowId >= earliestWindowRowId) continue;
        merged.set(row.rowId, row);
        if (row.kind === "turnHeader" && row.rowId === header.rowId) {
          turnStartMissing = false;
        }
      }
      if (!turnStartMissing) break;
      const earliestPageRow = result.rows[0];
      if (!result.hasMore || earliestPageRow === undefined) {
        rowsIncompleteReason = "exhausted";
        break;
      }
      // 游标推进校验：未推进说明行序被重写（或服务端异常），继续翻只会拿到同页。
      if (earliestPageRow.rowId >= beforeRowId) {
        rowsIncompleteReason = "log-rewritten";
        break;
      }
      beforeRowId = earliestPageRow.rowId;
      // 预算耗尽：最后一轮循环结束仍未命中起点。
      if (page === maxPages - 1) {
        rowsIncompleteReason = "budget";
      }
    }
  }
  const mergedSorted = [...merged.values()].sort((a, b) => a.rowId - b.rowId);
  const cut = collectTurnRowsFromWindow(mergedSorted, header);
  return materialFromRows(header, cut.rows, {
    truncatedRows: rowsIncompleteReason !== null || turnStartMissing,
    rowsIncompleteReason,
    toolOutputsTruncated: 0,
    turnStartMissing,
  });
}

/**
 * 从一段已有行集合直接抽取单轮材料（深度审查的更早相关轮次用：相关轮次的行
 * 已随候选历史取回，无需再翻页）。轮次起点缺失按 truncated 标注。
 */
export function extractTurnMaterialFromRows(
  header: OracleTurnHeaderRef,
  rows: readonly ConversationRow[],
): OracleTurnMaterialBundle {
  const cut = collectTurnRowsFromWindow(rows, header);
  return materialFromRows(header, cut.rows, {
    truncatedRows: cut.turnStartMissing,
    rowsIncompleteReason: null,
    toolOutputsTruncated: 0,
    turnStartMissing: cut.turnStartMissing,
  });
}

// ── prompt 渲染预算 ──
// 每类材料给独立预算而不是全局一刀切：长思考轮会把工具结果挤出 prompt。
const MAX_INPUT_TEXT_CHARS = 4_000;
const MAX_ASSISTANT_TEXT_CHARS = 12_000;
const MAX_TOOL_INPUT_CHARS = 1_200;
const MAX_TOOL_OUTPUT_CHARS = 6_000;
const MAX_TOOL_CALLS_RENDERED = 40;

function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

// origin 闭集（协议 rows.ts）里没有 "guided"：中途指导的 origin 就是 realUser，
// 靠行上的 guided 标记区分（见 originLabel），不要在这里加死键。
const ORIGIN_LABELS: Record<string, string> = {
  realUser: "用户",
  mailbox: "外部消息",
  backgroundResult: "后台任务结果",
  goalContinuation: "目标自动延续",
  synthetic: "系统注入",
  workflowLaunch: "工作流启动",
};

function originLabel(input: OracleUserInputEntry): string {
  // 中途指导（turn-steer）的 origin 也是 realUser，必须靠 guided 标记区分，
  // 否则指导文本会以「用户」身份冒充主请求。
  if (input.guided) return "用户（中途指导）";
  return ORIGIN_LABELS[input.origin] ?? input.origin;
}

/** 把单轮材料渲染成审查 prompt 的材料段（确定性文本，无 Markdown 表格依赖）。 */
export function renderOracleTurnMaterialText(
  material: OracleTurnMaterial,
  label: string,
): string {
  const sections: string[] = [`### ${label}`];
  if (material.userInputs.length > 0) {
    sections.push("#### 本轮输入");
    for (const input of material.userInputs) {
      const text = visibleUserInputText(input.text, input.epilogueStart).trim();
      // epilogueStart=0（nudge 轮）时整条都是引擎文本，没有用户原话：如实标注，
      // 不能把引擎样板当作「用户说的话」。
      sections.push(
        text
          ? `- [${originLabel(input)}] ${truncateWithEllipsis(text, MAX_INPUT_TEXT_CHARS)}`
          : `- [${originLabel(input)}]（该输入整条为引擎自动附加文本，无用户原话）`,
      );
    }
  } else {
    sections.push("#### 本轮输入\n（未找到用户输入行）");
  }
  if (material.assistantTexts.length > 0) {
    sections.push("#### 助手回复");
    for (const entry of material.assistantTexts) {
      sections.push(truncateWithEllipsis(entry.text, MAX_ASSISTANT_TEXT_CHARS));
    }
  } else {
    sections.push("#### 助手回复\n（本轮无可见正文回复）");
  }
  if (material.toolCalls.length > 0) {
    sections.push("#### 工具调用与执行结果");
    const rendered = material.toolCalls.slice(0, MAX_TOOL_CALLS_RENDERED);
    for (const call of rendered) {
      const lines = [
        `- [${call.toolName}] status=${call.status}${call.inputText ? ` 输入: ${truncateWithEllipsis(call.inputText, MAX_TOOL_INPUT_CHARS)}` : ""}`,
      ];
      if (call.errorMessage) {
        lines.push(`  错误: ${call.errorCode ?? ""} ${truncateWithEllipsis(call.errorMessage, 400)}`);
      }
      if (call.outputText) {
        const suffix = call.outputTruncated ? "（输出被截断，仅含部分结果）" : "";
        lines.push(`  结果: ${truncateWithEllipsis(call.outputText, MAX_TOOL_OUTPUT_CHARS)}${suffix}`);
      }
      sections.push(lines.join("\n"));
    }
    if (material.toolCalls.length > rendered.length) {
      sections.push(`（另有 ${material.toolCalls.length - rendered.length} 条工具调用未列出）`);
    }
  } else {
    sections.push("#### 工具调用与执行结果\n（本轮没有工具调用）");
  }
  return sections.join("\n\n");
}

/** 材料完整性说明（进 prompt 的「材料完整性」段与卡片的限制展示）。 */
export function describeMaterialCompleteness(
  completeness: OracleTurnMaterialCompleteness,
): string[] {
  const notes: string[] = [];
  if (completeness.turnStartMissing) {
    notes.push("未找到本回合的起点记录，材料按会话中可见的回合行组装，可能不完整。");
  }
  // 按实际原因分别陈述：把取数失败/翻到历史尽头/日志重写统一说成「预算上限」
  // 会让审查方误判信任度（误以为只是「数据多没取够」）。
  switch (completeness.rowsIncompleteReason) {
    case "budget":
      notes.push("历史行取数达到翻页预算上限，本回合部分记录可能未包含。");
      break;
    case "exhausted":
      notes.push("已翻到会话历史最早处仍未取全本回合的行，材料可能不完整。");
      break;
    case "fetch-failed":
      notes.push("历史行取数查询失败，本回合部分记录可能未包含。");
      break;
    case "no-window":
      notes.push("会话行窗口为空，无法组装本回合材料。");
      break;
    case "log-rewritten":
      notes.push("翻页取数期间会话日志发生重写（rewind/压缩），已停止拼接，材料可能不完整。");
      break;
    default:
      break;
  }
  if (completeness.toolOutputsTruncated > 0) {
    notes.push(`${completeness.toolOutputsTruncated} 条工具输出在记录层被截断，仅含部分结果。`);
  }
  return notes;
}

export { truncateWithEllipsis };
