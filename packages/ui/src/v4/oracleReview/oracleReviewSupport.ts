import type { ModelSelection } from "@zcode/shared";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/provider";
import type { OracleReviewDepth } from "@zcode/shared/oracle-review";
import type { OracleReviewTargetRef, OracleReviewableTurnState } from "./oracleReviewMaterial.js";
import type { OracleVerdict } from "./oracleReviewVerdict.js";

/**
 * Oracle 审查的 UI 侧控制面：审查请求契约、状态机、模型偏好存取与一键修复。
 *
 * 可复用的纯函数层（prompt / 裁决解析 / 材料组装 / 上下文分析 / diff 规则）已下沉到
 * `@zcode/shared/oracle-review`——CLI 的 `zcode review` 要复用同一套规则，而 CLI
 * 依赖链上不存在 ui 包。这里保留同名再导出，调用方与测试的 import 路径不变。
 *
 * 双模式语义（v2 改造后）：
 * - standard：单轮对话审查——目标回合的完整材料 + 必要前文，无工具单次生成；
 * - deep：跨轮任务审查——同一任务的多个相关轮次 + 只读工具对工作区取证。
 * 两种模式都只输出评价与建议，不执行修复。审查不再是「diff 把关」：没有文件
 * 改动的纯对话回合同样可审，diff 只降级为辅助证据。
 *
 * 与 usePromptOptimizer 同构：审查走**会话外** workspace generateText 请求，
 * 不产生消息、不进历史。
 */

export type { OracleReviewDepth };

export {
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
  ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
  ORACLE_DEEP_REVIEW_QUERY_SOURCE,
  ORACLE_DEEP_REVIEW_TIMEOUT_MS,
  ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE,
  ORACLE_CONTEXT_ANALYSIS_TIMEOUT_MS,
  isOracleReviewQuerySource,
  formatOraclePatch,
  buildOracleDiffSections,
  formatOracleCommitLine,
  type OracleDiffSection,
  type OracleReviewDiffHunk,
  type OracleReviewDiffItem,
} from "@zcode/shared/oracle-review";

/** 审查请求的全链路身份：各阶段 operationId 由它派生（ctx/review 后缀）。 */
export interface OracleReviewRequest {
  reviewId: string;
  depth: OracleReviewDepth;
  mode: OracleReviewRequestMode;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 目标轮次（点击时锁定，后续消息不改变对象）。 */
  target: OracleReviewTargetRef;
  /** 发起时的快照水位（诊断与陈旧校验；不是长期身份）。 */
  revision?: number;
  logEpoch?: string;
  createdAt: number;
}

/** 审查运行阶段：collecting 取材料 → analyzing 上下文分析 → reviewing 正式审查。 */
export type OracleReviewStage = "collecting" | "analyzing" | "reviewing";

// maxOutputTokens 由 useOracleReview 按模型声明的上限（optionSpecs.maxOutputTokens.max）
// 传入：省略会被 adapters 校验拒绝（outside the model option range），设小了会被
// 思考模型的 reasoning 吃光导致空正文（实测 2048 上限 GLM 返回空文本）。

export function isOracleDeadlineTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "ZCodeProtocolRequestTimeoutError";
}

export type OracleReviewRequestMode = "auto" | "manual";

export type OracleReviewFailure =
  | { kind: "no-turn" }
  | { kind: "no-model" }
  | { kind: "stale-target"; message: string }
  | { kind: "context-analysis"; message: string }
  /** 模型返回空正文：多为输出预算被 reasoning 耗尽（finishReason 可佐证）。 */
  | { kind: "empty-response"; finishReason?: string }
  /** 客户端 deadline 到点：多为渠道限流或深思考无首 token 的重试循环；message 供卡片展示底层错误。 */
  | { kind: "timeout"; message: string }
  | { kind: "request"; message: string };

/** 深度审查已执行的工具调用（横幅展示：读了哪些文件、跑了什么命令）。 */
export interface OracleReviewToolEvent {
  round: number;
  toolName: string;
  /** 展示目标：文件路径 / pattern / 命令；模型未给可提取字段时缺席。 */
  target?: string;
}

// 事件列表上限：横幅只做线索展示，长审查按最近 N 条滚动。
export const ORACLE_REVIEW_TOOL_EVENT_LIMIT = 40;

/** 追加一条工具事件并有界裁剪（保留最近 N 条）。 */
export function appendOracleReviewToolEvent(
  events: readonly OracleReviewToolEvent[],
  next: OracleReviewToolEvent,
): OracleReviewToolEvent[] {
  const appended = [...events, next];
  return appended.length > ORACLE_REVIEW_TOOL_EVENT_LIMIT
    ? appended.slice(appended.length - ORACLE_REVIEW_TOOL_EVENT_LIMIT)
    : appended;
}

/**
 * 审查过程轨迹（侧栏面板的「会话流」）：阶段、工具调用与逐轮可见正文。
 * 与 toolEvents 的分工：trace 是面板的唯一渲染来源且跨阶段累计；toolEvents
 * 只服务输入框卡片的紧凑计数（新阶段开始即清空）。
 */
export type OracleReviewTraceEntry =
  | { kind: "stage"; stage: OracleReviewStage; at: number }
  | { kind: "tool"; round: number; toolName: string; target?: string; at: number }
  | {
      kind: "text";
      stage: OracleReviewStage;
      round: number;
      text: string;
      /** 超过单条上限、只保留尾部时置位（面板显示「已截断」提示）。 */
      truncated?: boolean;
    };

/** 轨迹条目上限：面板只回放最近 200 条，避免长审查把内存与渲染拖住。 */
export const ORACLE_REVIEW_TRACE_LIMIT = 200;
/** 单条正文上限（按字符）：超出保留尾部，实时流继续可见。 */
export const ORACLE_REVIEW_TRACE_TEXT_CAP = 20_000;

/**
 * 追加一条轨迹。正文条目按 stage+round 与上一条合并（流式增量很多，逐条存
 * 会把 200 条上限吃掉）；合并后仍超上限时保留尾部并标记 truncated。
 */
export function appendOracleReviewTraceEntry(
  trace: readonly OracleReviewTraceEntry[],
  entry: OracleReviewTraceEntry,
): OracleReviewTraceEntry[] {
  if (entry.kind === "text") {
    const last = trace[trace.length - 1];
    if (last?.kind === "text" && last.stage === entry.stage && last.round === entry.round) {
      const merged = last.text + entry.text;
      const truncated = last.truncated === true || merged.length > ORACLE_REVIEW_TRACE_TEXT_CAP;
      const text = truncated ? merged.slice(-ORACLE_REVIEW_TRACE_TEXT_CAP) : merged;
      return [
        ...trace.slice(0, -1),
        { ...last, text, ...(truncated ? { truncated: true as const } : {}) },
      ];
    }
  }
  const appended = [...trace, entry];
  return appended.length > ORACLE_REVIEW_TRACE_LIMIT
    ? appended.slice(appended.length - ORACLE_REVIEW_TRACE_LIMIT)
    : appended;
}

export type OracleReviewState =
  | { status: "idle" }
  | {
      status: "pending";
      mode: OracleReviewRequestMode;
      reviewId: string;
      /** pending 起始时间戳：存进 store（跨会话切换/重挂载存活），计时不再重置。 */
      startedAt: number;
      /** 当前运行阶段（collecting/analyzing/reviewing），卡片展示进度。 */
      stage: OracleReviewStage;
      /** 本次审查实际使用的把关模型（providerId/modelId），卡片 pending 时展示。 */
      modelLabel: string;
      /** 标准（单轮对话）或深度（跨轮任务）。 */
      depth: OracleReviewDepth;
      /** 锁定的审查请求（重试、迟到写回校验与取消都用它，不重选目标）。 */
      request: OracleReviewRequest;
      /** 阶段在飞 operationId（进度按它精确路由；标准/深度/上下文各有后缀）。 */
      operationId?: string;
      /** 深度审查的当前轮次（进度通知推送；标准审查缺席）。 */
      round?: number;
      /** 深度审查正在执行的工具名（工具执行阶段；生成阶段清空）。 */
      toolName?: string;
      /** 当前工具调用的展示目标（文件路径 / pattern / 命令）。 */
      toolTarget?: string;
      /** 深度审查已执行的工具调用（有界），供横幅列出已读文件/命令。 */
      toolEvents?: readonly OracleReviewToolEvent[];
      /** 审查过程轨迹（阶段/工具/逐轮正文），供侧栏面板回放；跨阶段累计。 */
      trace?: readonly OracleReviewTraceEntry[];
    }
  | {
      status: "result";
      mode: OracleReviewRequestMode;
      reviewId: string;
      /** 目标轮次（result 必带完整目标身份；rowId 仅诊断）。 */
      turnRowId: number;
      entityId: string;
      verdict: OracleVerdict;
      summary: string;
      findings: string;
      /** deep：需求核验表（REQUIREMENTS 段原文，逐行）。 */
      requirements?: string;
      /** 实际审查覆盖范围（SCOPE 段）。 */
      scope?: string;
      /** 审查限制（LIMITS 段）。 */
      limits?: string;
      modelLabel: string;
      depth: OracleReviewDepth;
      completedAt: number;
      /** 会话加载时从持久记录恢复（非本次运行产出），卡片可标注「已恢复」。 */
      restored?: boolean;
      /** 锁定的审查请求（「重新审查」按原目标/深度重试，不重选最近成功轮）。 */
      request?: OracleReviewRequest;
      /** 本次审查的过程轨迹；持久恢复的记录没有轨迹（只回放结论）。 */
      trace?: readonly OracleReviewTraceEntry[];
    }
  | {
      status: "error";
      mode: OracleReviewRequestMode;
      reviewId?: string;
      failure: OracleReviewFailure;
      /** 发起请求后的把关模型（providerId/modelId）；错误卡片展示，渠道选错一眼可辨。请求前早退（无回合等）缺席。 */
      modelLabel?: string;
      depth: OracleReviewDepth;
      /** 锁定的审查请求（错误重试必须回到同一目标，不重新选择最近成功轮）。 */
      request?: OracleReviewRequest;
      /** 失败前已产生的轨迹（面板可定位卡在哪个阶段）。 */
      trace?: readonly OracleReviewTraceEntry[];
    };

/** 一键修复：把 findings 原文注入下一轮请求，由用户亲手触发，不自动循环。 */
export function buildOracleFixPrompt(findings: string): string {
  return [
    "上一轮经过了 Oracle 审查，发现以下问题，请逐条处理：",
    "",
    findings,
    "",
    "完成后逐条说明每个问题的处理方式；如某条经核实不成立，请说明理由而不是静默忽略。",
  ].join("\n");
}

const ORACLE_MODEL_STORAGE_KEY = "zcode-oracle-model";

/** 用户指定的 Oracle 审查模型（全局偏好）；null = 跟随会话模型。 */
export function readStoredOracleModelSelection(): ModelSelection | null {
  try {
    const raw = localStorage.getItem(ORACLE_MODEL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const providerId = record.providerId;
    const modelId = record.modelId;
    if (
      typeof providerId !== "string" ||
      typeof modelId !== "string" ||
      !providerId.trim() ||
      !modelId.trim()
    ) {
      return null;
    }
    // 推理档位与模型选择一起持久化：档位属于「把关强度交给用户」的选择，读回时
    // 丢掉会让它重启后静默回退（且缺档请求更可能被 modelFactory 校验拒绝）。
    const optionsRecord =
      record.options && typeof record.options === "object" && !Array.isArray(record.options)
        ? (record.options as Record<string, unknown>)
        : null;
    const reasoningLevel =
      optionsRecord && typeof optionsRecord.reasoningLevel === "string"
        ? optionsRecord.reasoningLevel.trim()
        : "";
    return {
      providerId: providerId.trim(),
      modelId: modelId.trim(),
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    };
  } catch {
    return null;
  }
}

export function writeStoredOracleModelSelection(selection: ModelSelection | null): void {
  try {
    if (!selection) {
      localStorage.removeItem(ORACLE_MODEL_STORAGE_KEY);
    } else {
      localStorage.setItem(ORACLE_MODEL_STORAGE_KEY, JSON.stringify(selection));
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默放弃持久化，选择仍在本会话内生效。
  }
}

/**
 * 解析把关请求的执行选项：模型选择 + 输出预算。
 *
 * 档位（reasoningLevel）**跟随用户显式选择，本函数不补档、不升级**：实测把关模型
 * 在最高档上单轮思考可达 10 分钟（慢渠道），多轮深度审查在 20 分钟 deadline 内
 * 结构性无法收敛。落盘偏好恒为显式档位（设置页写入 + 会话层一次性迁移保证）；
 * 模型缺席视图等无法解析的情况让错误如实上报。
 *
 * maxOutputTokens 跟随模型声明的上限（optionSpecs.maxOutputTokens.max，与主回合
 * 「打满模型声明上限」同语义）：省略会被 adapters 的 validateOptions 以
 * 「outside the model option range」拒绝；设小了会被思考模型的 reasoning 吃光
 * 导致空正文（实测 2048 上限 GLM 返回空文本）。模型视图缺席该值时才省略并让
 * 错误如实上报。
 */
export function resolveOracleRequestOptions(
  oracleModel: ModelSelection | null,
  modelSelectionView: ModelSelectionView | null | undefined,
): { selection: ModelSelection; maxOutputTokens?: number } | null {
  // 「跟随会话模型」只能取视图对**会话当前选择**的解析结果（effectiveSelection）；
  // preferredSelection 是 Host 初始推荐/配置默认模型，不随会话换模型，拿它会把
  // 「跟随」变成「跟随默认模型」（实测：会话用 deepseek，审查却跑 cmd3/glm）。
  const selection = oracleModel ?? modelSelectionView?.effectiveSelection ?? null;
  if (!selection) {
    return null;
  }
  const provider = modelSelectionView?.providers.find(
    (candidate) => candidate.providerId === selection.providerId,
  );
  const model = provider?.models.find((candidate) => candidate.modelId === selection.modelId);
  const specMax = model?.config.optionSpecs.maxOutputTokens?.max;
  return {
    selection,
    ...(typeof specMax === "number" && Number.isFinite(specMax) && specMax > 0
      ? { maxOutputTokens: specMax }
      : {}),
  };
}

/** SessionPane → composer / 行渲染注入的完整控制面；composer 不再自持 hook 实例。 */
export interface OracleReviewController {
  state: OracleReviewState;
  /**
   * 「回合成功后的自动把关」开关（settings.oracleReviewEnabled）。语义仅限自动把关：
   * 手动入口（composer 两个按钮 / 轮尾 reviewTurnHeader）不据此隐藏——关掉自动不代表
   * 不想手动审查，用同一开关连带隐藏入口会让用户找不到手动审查。
   */
  enabled: boolean;
  /** pending 已等待秒数（每秒跳动）；结果/错误态归零。 */
  pendingElapsedSeconds: number;
  /** pending 期间模型已累计输出的字符数（正文+思考，CLI 流式进度推送）；非 pending 归零。 */
  pendingOutputChars: number;
  manualReview: () => void;
  /** 深度审查（跨轮任务核查，只读取证）：仅手动入口，成本数倍于标准审查。 */
  deepReview: () => void;
  reviewTurnHeader: (header: TurnHeaderRow) => void;
  /** 轮尾工具栏的深度审查入口：与 reviewTurnHeader 同一准入条件。 */
  reviewTurnHeaderDeep: (header: TurnHeaderRow) => void;
  /** 按原请求重试（同目标/同深度/同模式），错误与中断卡片共用；无请求时退化为手动审查。 */
  retryReview: () => void;
  dismiss: () => void;
  /**
   * 展开右侧审查面板（完整结论 + 逐轮过程）。宿主未接线时缺席，卡片不显示「展开」。
   * 与 dismiss 不同：只切查看位置，不改变审查状态。
   */
  onOpenPanel?: () => void;
  /**
   * 落盘「这条审查用户已确认」（✕ 关闭 / 按建议处理）。持久化后会话重启不再把它
   * 恢复成卡片；best-effort，失败只记日志不影响界面。
   */
  acknowledge: () => void;
}

export type { OracleReviewableTurnState };

// prompt 构建拆至 oracleReviewPrompt.ts（max-lines）；此处转出保持调用方 import 路径不变。
export { buildOracleReviewPrompt, type OracleReviewTaskScope } from "./oracleReviewPrompt.js";

// 裁决解析拆至 oracleReviewVerdict.ts（max-lines）；此处转出保持调用方 import 路径不变。
export {
  type OracleVerdict,
  type OracleVerdictParse,
  parseOracleVerdict,
} from "./oracleReviewVerdict.js";
