import type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
export type {
  ConversationTurnRenderUnit,
  BuildConversationTurnRenderUnitsOptions,
} from "@/v4/conversationTurnRenderUnitTypes.js";
import type {
  AssistantTextRow,
  ConversationRow,
  HookInvocationRow,
  SessionPhase,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
import {
  isWorkflowLaunchUserInputRow,
  resolveWorkflowLaunchMeta,
} from "@/v4/workflowLaunchTurn.js";
import {
  buildConversationTurnWorkSegments,
  resolveConversationTurnWorkDurationMs,
  resolveConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
import { markHighspeedOutputFooterUnits } from "@/highspeed/highspeedOutputFooter.js";

export type { AssistantWorkRow, ConversationTurnFlowItem } from "@/v4/conversationTurnFlowItems.js";
export type {
  ConversationTurnWorkSegment,
  ConversationTurnWorkStatus,
} from "@/v4/conversationTurnWorkSegments.js";
export { resolveNextHighspeedExpiryMs } from "@/highspeed/highspeedConversationRows.js";

interface DraftTurnRenderUnit {
  key: string;
  turnId: string;
  header?: TurnHeaderRow;
  userInputs: UserInputRow[];
  assistantWorkRows: AssistantWorkRow[];
  hookInvocations: HookInvocationRow[];
  orderedRows: ConversationRow[];
}

function isAssistantTextRow(row: ConversationRow): row is AssistantTextRow {
  return row.kind === "assistantText";
}

function isTurnHeaderRow(row: ConversationRow): row is TurnHeaderRow {
  return row.kind === "turnHeader";
}

function isUserInputRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput";
}

function isTimelineMarkerRow(row: ConversationRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker";
}

function isHookInvocationRow(row: ConversationRow): row is HookInvocationRow {
  return row.kind === "hookInvocation";
}

function isVisibleAssistantWorkRow(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning" && row.text.trim().length === 0) {
    // reasoning_start/reasoning_end 可能形成空的终态 block；只在共享
    // render-unit 边界裁掉它，避免 completed 状态绕过 streaming renderer 的空行过滤。
    return false;
  }
  // EnterPlanMode 只是内部模式切换边界，把它当普通工具放进“已工作”，
  // 会显示一条没有用户价值的“工具调用已执行”。只在 render unit 过滤，不改写协议投影，
  // 以保留 desktop continuous / web remote replayable 共用的运行态与恢复语义。
  return row.kind !== "toolCall" || row.toolName !== "EnterPlanMode";
}

function isVisibleConversationRow(row: ConversationRow): boolean {
  if (isUserInputRow(row)) return true;
  if (isTurnHeaderRow(row)) return false;
  if (isHookInvocationRow(row)) return false;
  return isVisibleAssistantWorkRow(row);
}

// 落位语义（lane）由 CLI 投影裁决下发（UI 不得按 marker type 自行推断）。
// lane 缺省（不应发生）按 assistantWork 兜底——降级进折叠组，不丢行。
function isTurnEndingTimelineMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "turnTailBoundary";
}

/**
 * artifact 行是分享投影追加到轮尾的产出物（insertDiscoveredArtifacts 插在该
 * productTurn 最后一行之后），但它同样属于 AssistantWorkRow，会成为 flow 的最后一行。
 * 于是折叠锚点的兜底条件「最后一行是 assistantText」失效——公开投影禁止 actions，
 * 分享页只有这条兜底——最终答复被卷进「已工作」并整轮默认展开。
 *
 * 它是追加的产出物、不属于对话流，按轮尾处理即可；与 browserTurnEndRows 摘轮尾截图同理。
 * 注意不能改成「取 flow 里最后一条 assistantText」：那会把 CUA 响应中途的正文
 * 提升成最终答复，拆散同一个 assistantResponseId 的分组。
 */
function isTurnTrailingArtifactRow(row: AssistantWorkRow): boolean {
  return row.kind === "artifact";
}

function splitTurnTailRows(rows: readonly AssistantWorkRow[]): {
  flowRows: AssistantWorkRow[];
  tailRows: AssistantWorkRow[];
} {
  let tailStart = rows.length;
  while (
    tailStart > 0 &&
    (isTurnEndingTimelineMarkerRow(rows[tailStart - 1]!) ||
      isTurnTrailingArtifactRow(rows[tailStart - 1]!))
  ) {
    tailStart -= 1;
  }
  return {
    flowRows: rows.slice(0, tailStart),
    tailRows: rows.slice(tailStart),
  };
}

function isBrowserTurnEndRow(row: AssistantWorkRow): boolean {
  // 自动截图以完成态 tool row 持久化在最终正文之后，旧分组只把
  // timeline boundary 识别为轮尾，导致截图被搬进上方“已工作”折叠区而不可见。
  return (
    row.kind === "toolCall" &&
    row.display?.kind === "node_repl_images" &&
    row.display.source === "browser_turn_end"
  );
}

function isLightBoundaryMarkerRow(row: AssistantWorkRow): row is TimelineMarkerRow {
  return row.kind === "timelineMarker" && row.lane === "lightBoundary";
}

function isCompletionBlockingWorkRowRunning(row: AssistantWorkRow): boolean {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.state === "streaming";
    case "toolCall":
      return (
        row.backgrounded !== true &&
        (row.status === "inputStreaming" ||
          row.status === "pendingApproval" ||
          row.status === "running")
      );
    case "subagent":
      return row.backgrounded !== true && row.status === "running";
    case "timelineMarker":
      return "status" in row.marker && row.marker.status === "running";
    default:
      return false;
  }
}

function resolveTurnRunning(
  draft: DraftTurnRenderUnit,
  options: BuildConversationTurnRenderUnitsOptions,
): boolean {
  if (draft.header) {
    if (draft.header.executionKind === "controlOnly") return false;
    // turnHeader 是 projection 的权威轮次边界；已终态主轮不能被
    // 同轮仍在运行的 background tool/subagent 行重新推成 running。
    return draft.header.state === "running";
  }
  if (
    options.sessionPhase === "completedSuccess" ||
    options.sessionPhase === "completedInterrupted" ||
    options.sessionPhase === "error"
  ) {
    // cold snapshot 只保留尾窗时可能裁掉 turnHeader；旧 fallback 会把
    // 孤立的 inputStreaming/running tool row 重新推成 thinking，终态 control 必须优先。
    return false;
  }
  // 仅兼容缺少 turnHeader 的旧投影；background-only work 不阻塞主轮完成。
  return draft.assistantWorkRows.some(isCompletionBlockingWorkRowRunning);
}

function shouldForceOpenAbnormalHistory(
  header: TurnHeaderRow | undefined,
  sessionPhase: SessionPhase | undefined,
): boolean {
  if (header) {
    return header.state === "completedInterrupted" || header.state === "failed";
  }
  return sessionPhase === "completedInterrupted" || sessionPhase === "error";
}

function materializeDraftUnit(
  draft: DraftTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const workflowLaunch = resolveWorkflowLaunchMeta(draft.header, draft.userInputs);
  // 启动轮的用户行由 run 卡代言，不进可见输入也不进流。
  const renderedRows =
    workflowLaunch === undefined
      ? draft.orderedRows
      : draft.orderedRows.filter((row) => !isWorkflowLaunchUserInputRow(row));
  const visibleUserInputs = renderedRows.filter(isUserInputRow);
  const visibleAssistantWorkRows = draft.assistantWorkRows.filter(isVisibleAssistantWorkRow);
  const visibleOrderedRows = renderedRows.filter(isVisibleConversationRow);
  const timelineOnly =
    visibleUserInputs.length === 0 &&
    visibleAssistantWorkRows.length > 0 &&
    visibleAssistantWorkRows.every(isTimelineMarkerRow);

  // modelChange 是轮顶轻边界，渲染在 user 输入之前，不进工作流。
  const leadingBoundaryRows = timelineOnly
    ? []
    : visibleAssistantWorkRows.filter(isLightBoundaryMarkerRow);
  const leadingBoundaryRowIds = new Set(leadingBoundaryRows.map((row) => row.rowId));
  const bodyRows = timelineOnly
    ? visibleAssistantWorkRows
    : visibleAssistantWorkRows.filter((row) => !isLightBoundaryMarkerRow(row));
  // Browser 自动截图要越过 file diff 摘要成为最后内容块，因此先单独抽取；
  // 其余 row 仍按 CLI 全序处理，只有连续的真实轮尾 marker 后缀可从 flow 拆出。
  const browserTurnEndRows: AssistantWorkRow[] = [];
  const nonBrowserRows: AssistantWorkRow[] = [];
  if (!timelineOnly) {
    for (const row of bodyRows) {
      if (isBrowserTurnEndRow(row)) {
        browserTurnEndRows.push(row);
      } else {
        nonBrowserRows.push(row);
      }
    }
  }
  // 不能用 filter 抽取所有 turnTailBoundary，并把 ExitPlanMode 也强行归入 tail，
  // 会把计划和中间 marker 从原 tool row 搬到轮底。其余 row 必须留在 flow 中。
  const { flowRows, tailRows: assistantTailRows } = timelineOnly
    ? { flowRows: [], tailRows: [] }
    : splitTurnTailRows(nonBrowserRows);

  const isLastTurn = index === total - 1;
  const isRunning = resolveTurnRunning(draft, options);
  const isInterrupted = draft.header
    ? draft.header.state === "completedInterrupted"
    : options.sessionPhase === "completedInterrupted";
  // 旧展开规则只看 running 和最终正文，异常终态一旦保留 partial assistant text
  // 就会被当作正常完成而收起，隐藏中断/失败上下文。终态必须以 header 为权威；冷恢复
  // 尾窗缺 header 时才回退 session phase，desktop continuous 与 mobile replayable 共用此边界。
  const forceOpenHistory = shouldForceOpenAbnormalHistory(draft.header, options.sessionPhase);

  // product turn 的最终正文仍是唯一 action target；视觉工作段只改变折叠边界。
  const assistantTextRows = flowRows.filter(isAssistantTextRow);
  const actionAssistantTextRow = assistantTextRows.find(
    (row) => row.actions?.canFork === true || row.actions?.canRetry === true,
  );
  const lastFlowRow = flowRows.at(-1);
  const latestAssistantTextRow =
    actionAssistantTextRow ??
    (!isRunning && lastFlowRow && isAssistantTextRow(lastFlowRow) ? lastFlowRow : undefined);
  const workDurationMs = resolveConversationTurnWorkDurationMs(draft.header, options, isRunning);
  const workStatus = resolveConversationTurnWorkStatus(
    draft.header,
    bodyRows,
    isRunning,
    workDurationMs,
    isInterrupted,
  );
  const browserTurnEndRowIds = new Set(browserTurnEndRows.map((row) => row.rowId));
  const orderedBodyRows = visibleOrderedRows.filter(
    // main 的 workSegments 会从 orderedRows 重建 flow；如果这里只从
    // bodyRows 抽取截图，它仍会被塞回正文流并在轮尾再次渲染，造成重复和顺序错乱。
    (row) => !leadingBoundaryRowIds.has(row.rowId) && !browserTurnEndRowIds.has(row.rowId),
  );
  const workSegments = buildConversationTurnWorkSegments({
    key: draft.key,
    header: draft.header,
    orderedRows: orderedBodyRows,
    assistantTailRows,
    latestAssistantTextRow,
    isRunning,
    isLastTurn,
    isInterrupted,
    forceOpenHistory,
    timelineOnly,
    nowMs: options.nowMs,
    ...(options.pluginUiPinResolver ? { pluginUiPinResolver: options.pluginUiPinResolver } : {}),
  });
  const orderedAssistantHistoryRows = workSegments.flatMap(
    (segment) => segment.assistantHistoryRows,
  );
  const assistantFollowingRows = workSegments.flatMap((segment) => segment.assistantFollowingRows);
  const flowItems = workSegments.flatMap((segment) => segment.flowItems);
  const mustOpenHistory = workSegments.at(-1)?.assistantHistoryDefaultOpen ?? false;
  return {
    key: draft.key,
    turnId: draft.turnId,
    ...(draft.header ? { header: draft.header } : {}),
    visibleUserInputs,
    // 轻边界已经由 leadingBoundaryRows 独立承载，不能再算作 assistant work。
    assistantWorkRows: bodyRows,
    assistantHistoryRows: orderedAssistantHistoryRows,
    assistantFollowingRows,
    assistantTailRows,
    browserTurnEndRows,
    hookInvocations: draft.hookInvocations,
    assistantTextRows,
    leadingBoundaryRows,
    ...(latestAssistantTextRow ? { latestAssistantTextRow } : {}),
    flowItems,
    workSegments,
    // renderRows 是查找/诊断用的平面视图，也必须服从 CLI row 全序。
    renderRows: visibleOrderedRows,
    isLastTurn,
    isRunning,
    assistantHistoryDefaultOpen: mustOpenHistory,
    timelineOnly,
    ...(workStatus ? { workStatus } : {}),
    ...(draft.header ? { startedAt: draft.header.startedAt } : {}),
    ...(workflowLaunch ? { workflowLaunch } : {}),
  };
}

function createDraftUnit(turnId: string): DraftTurnRenderUnit {
  return {
    // cold snapshot 可能从同一 turn 的 assistant/tool 行中间截断，补到
    // turnHeader 后首个可见 rowId 会变化。虚拟列表 key 必须只依赖协议稳定的 turnId，
    // 否则补页会把原 turn 当成新节点重挂，丢失测高缓存和视口锚点。
    key: turnId,
    turnId,
    userInputs: [],
    assistantWorkRows: [],
    hookInvocations: [],
    orderedRows: [],
  };
}

interface TurnRenderUnitCacheEntry {
  header: TurnHeaderRow | undefined;
  orderedRowRefs: readonly ConversationRow[];
  sessionPhase: SessionPhase | undefined;
  /** pluginUiPinResolver 身份（=== 比较）；undefined 也是一个合法且稳定的取值。 */
  resolver: unknown;
  /** materializeDraftUnit 的 isLastTurn = index === drafts.length - 1（过滤前）。 */
  isLastMaterialize: boolean;
  unit: ConversationTurnRenderUnit;
}

/**
 * 性能开关 stableRenderUnitsEnabled 的按 turn 缓存（实例级，由 Timeline 持有；
 * 不能做模块级——多 session / 分享视图会串用）。
 *
 * 协议 apply 是不可变的：未变行保持引用 ⇒ 「行引用一致 = 内容一致」。命中条件
 * 覆盖 materializeDraftUnit 的全部输入维度（行引用、sessionPhase、resolver 身份、
 * 轮位标志）；running 轮永不缓存（workDurationMs/workSegments 依赖 nowMs）。
 * normalizeRenderUnitPosition 自带无变化早退，缓存的是 materialize 结果，
 * 位置变化由 normalize 兜底。Highspeed footer 打标与最终数组另有二级 memo。
 */
export class TurnRenderUnitCache {
  private static readonly MAX_ENTRIES = 2000;
  private entries = new Map<string, TurnRenderUnitCacheEntry>();
  /** 打标结果按源 unit 引用复用：过期是单调的、card 元数据不可变。 */
  private footerMarks = new WeakMap<object, ConversationTurnRenderUnit>();
  private lastOutput: ConversationTurnRenderUnit[] | null = null;

  reset(): void {
    this.entries = new Map();
    this.footerMarks = new WeakMap();
    this.lastOutput = null;
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(
    turnId: string,
    draft: DraftTurnRenderUnit,
    options: BuildConversationTurnRenderUnitsOptions,
    isLastMaterialize: boolean,
  ): ConversationTurnRenderUnit | undefined {
    const entry = this.entries.get(turnId);
    if (!entry) return undefined;
    if (
      entry.header === draft.header &&
      entry.sessionPhase === options.sessionPhase &&
      entry.resolver === options.pluginUiPinResolver &&
      entry.isLastMaterialize === isLastMaterialize &&
      entry.orderedRowRefs.length === draft.orderedRows.length &&
      entry.orderedRowRefs.every((ref, index) => ref === draft.orderedRows[index])
    ) {
      return entry.unit;
    }
    return undefined;
  }

  store(
    turnId: string,
    draft: DraftTurnRenderUnit,
    options: BuildConversationTurnRenderUnitsOptions,
    isLastMaterialize: boolean,
    unit: ConversationTurnRenderUnit,
  ): void {
    if (this.entries.size >= TurnRenderUnitCache.MAX_ENTRIES) {
      this.entries = new Map();
    }
    this.entries.set(turnId, {
      header: draft.header,
      // 复制一份引用数组：draft 是本次构建的临时对象，随后会被复用/丢弃。
      orderedRowRefs: [...draft.orderedRows],
      sessionPhase: options.sessionPhase,
      resolver: options.pluginUiPinResolver,
      isLastMaterialize,
      unit,
    });
  }

  /** Highspeed footer 打标复用：同源 unit 的打标结果跨 tick 稳定。 */
  reuseFooterMark(
    source: ConversationTurnRenderUnit,
    marked: ConversationTurnRenderUnit,
  ): ConversationTurnRenderUnit {
    const cached = this.footerMarks.get(source);
    if (cached) return cached;
    this.footerMarks.set(source, marked);
    return marked;
  }

  /** 全命中时返回上一次的数组引用，让下游 useMemo（liveTail/summary 等）不再重算。 */
  reuseLastOutput(units: ConversationTurnRenderUnit[]): ConversationTurnRenderUnit[] {
    const previous = this.lastOutput;
    if (
      previous &&
      previous.length === units.length &&
      units.every((unit, index) => unit === previous[index])
    ) {
      return previous;
    }
    this.lastOutput = units;
    return units;
  }
}

function shouldKeepRenderUnit(unit: ConversationTurnRenderUnit): boolean {
  // 隐形行清零后（投影不再产不可渲染 marker），任何工作行都可渲染；
  // 「哪些 marker 可渲染」不再是 UI 的判断。
  return (
    unit.visibleUserInputs.length > 0 ||
    unit.assistantWorkRows.length > 0 ||
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute)) ||
    unit.leadingBoundaryRows.length > 0 ||
    // 直接启动轮：用户行不可见、无助手内容，轮由 run 卡呈现——它当然要留下。
    unit.workflowLaunch !== undefined ||
    unit.isRunning
  );
}

function normalizeRenderUnitPosition(
  unit: ConversationTurnRenderUnit,
  index: number,
  total: number,
  options: BuildConversationTurnRenderUnitsOptions,
): ConversationTurnRenderUnit {
  const isLastTurn = index === total - 1;
  const forceOpenHistory = shouldForceOpenAbnormalHistory(unit.header, options.sessionPhase);
  const assistantHistoryDefaultOpen =
    unit.workSegments && unit.workSegments.length > 0
      ? !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workSegments.at(-1)?.workStatus?.state === "running") ||
          (unit.workSegments.length === 1 &&
            unit.latestAssistantTextRow === undefined &&
            unit.assistantWorkRows.length > 0))
      : !unit.timelineOnly &&
        (forceOpenHistory ||
          (isLastTurn && unit.workStatus?.state === "running") ||
          (unit.latestAssistantTextRow === undefined && unit.assistantWorkRows.length > 0));
  const workSegments = unit.workSegments?.map((segment, segmentIndex, segments) =>
    segmentIndex === segments.length - 1
      ? {
          ...segment,
          assistantHistoryDefaultOpen:
            !unit.timelineOnly &&
            (forceOpenHistory ||
              (isLastTurn && segment.workStatus?.state === "running") ||
              (segments.length === 1 &&
                unit.latestAssistantTextRow === undefined &&
                segment.assistantWorkRows.length > 0)),
        }
      : segment,
  );
  if (
    unit.isLastTurn === isLastTurn &&
    unit.assistantHistoryDefaultOpen === assistantHistoryDefaultOpen &&
    workSegments?.at(-1)?.assistantHistoryDefaultOpen ===
      unit.workSegments?.at(-1)?.assistantHistoryDefaultOpen
  ) {
    return unit;
  }
  return {
    ...unit,
    isLastTurn,
    assistantHistoryDefaultOpen,
    ...(workSegments ? { workSegments } : {}),
  };
}

export function buildConversationTurnRenderUnits(
  rows: readonly ConversationRow[],
  options: BuildConversationTurnRenderUnitsOptions = {},
): ConversationTurnRenderUnit[] {
  const units: DraftTurnRenderUnit[] = [];
  const unitByTurnId = new Map<string, DraftTurnRenderUnit>();

  const getOrCreateUnit = (turnId: string) => {
    const existing = unitByTurnId.get(turnId);
    if (existing) {
      return existing;
    }
    const unit = createDraftUnit(turnId);
    units.push(unit);
    unitByTurnId.set(turnId, unit);
    return unit;
  };

  for (const row of rows) {
    const unit = getOrCreateUnit(row.turnId);
    if (isTurnHeaderRow(row)) {
      unit.header = row;
      continue;
    }
    unit.orderedRows.push(row);
    if (isUserInputRow(row)) {
      unit.userInputs.push(row);
      continue;
    }
    if (isHookInvocationRow(row)) {
      unit.hookInvocations.push(row);
      continue;
    }
    unit.assistantWorkRows.push(row);
  }

  // stableRenderUnitsEnabled（默认关闭）：unitCache 缺省时与原路径逐字节一致。
  const unitCache = options.unitCache ?? null;
  const totalDrafts = units.length;
  const materializedUnits = units.map((unit, index) => {
    const isLastMaterialize = index === totalDrafts - 1;
    if (unitCache) {
      // running 轮的 workDurationMs/workSegments 依赖 nowMs，永不缓存。
      if (!resolveTurnRunning(unit, options)) {
        const cached = unitCache.lookup(unit.turnId, unit, options, isLastMaterialize);
        if (cached) return cached;
        const materialized = materializeDraftUnit(unit, index, totalDrafts, options);
        unitCache.store(unit.turnId, unit, options, isLastMaterialize, materialized);
        return materialized;
      }
    }
    return materializeDraftUnit(unit, index, totalDrafts, options);
  });
  const keptUnits = materializedUnits.filter(shouldKeepRenderUnit);
  const normalizedUnits = keptUnits.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
  );
  if (!unitCache) {
    return markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
  }
  // footer 打标 + 最终数组二级复用：打标过的 unit 跨 tick 引用稳定；全命中时
  // 返回上一次的数组引用（下游 useMemo 不再因每秒 tick 重算）。
  const marked = markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
  const stabilized = marked.map((unit, index) =>
    unit === normalizedUnits[index]
      ? unit
      : unitCache.reuseFooterMark(normalizedUnits[index]!, unit),
  );
  return unitCache.reuseLastOutput(stabilized);
}
