import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  buildOracleDiffSections,
  ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE,
  ORACLE_CONTEXT_ANALYSIS_TIMEOUT_MS,
  type OracleDiffSection,
  type OracleReviewRequest,
} from "./oracleReviewSupport.js";
import {
  assembleOracleTurnMaterial,
  describeMaterialCompleteness,
  extractTurnMaterialFromRows,
  renderOracleTurnMaterialText,
  type OracleReviewTargetRef,
  type OracleTurnMaterial,
  type OracleTurnMaterialBundle,
} from "./oracleReviewMaterial.js";
import {
  buildOracleContextAnalysisPrompt,
  collectContextCandidates,
  parseOracleContextAnalysis,
  renderContextCandidates,
  type OracleContextAnalysis,
} from "./oracleReviewContextAnalysis.js";
import {
  readOracleRecentCommitSubjects,
  readOracleWorkspaceDiff,
} from "./oracleReviewContextFetch.js";

/**
 * 审查的阶段取数层（从 oracleReviewRunner 拆出，控制文件行数）：
 * - gatherOracleTurnEvidence：目标轮完整材料 + 辅助 diff 证据 + 最近提交；
 * - analyzeOracleReviewContext：上下文分析调用/解析/校验 + 深度审查的更早相关
 *   轮次材料组装（rowId 已过代码校验）。
 */

// 服务访问器可能是 null；这里取非空视图再做属性索引（类型层不允许对联合索引）。
type ServiceAccessor = NonNullable<ReturnType<typeof useOptionalServices>>;

/** 上下文分析失败的标记错误名：runner 的外层 catch 据此归类 failure.kind。 */
export const CONTEXT_ANALYSIS_ERROR_NAME = "OracleContextAnalysisError";

export interface OracleGatheredEvidence {
  bundle: OracleTurnMaterialBundle;
  /** 材料完整性说明（取数层缺口；分析层缺口由 analyze 步骤追加）。 */
  completenessNotes: string[];
  /** 辅助证据：回合级 diff；为空是合法状态（纯对话回合）。 */
  sections: OracleDiffSection[];
  diffSource?: "turn" | "workspace";
  recentCommits: readonly string[] | null;
}

export async function gatherOracleTurnEvidence(params: {
  agentService: NonNullable<ServiceAccessor["zcodeAgentService"]>;
  gitService: ServiceAccessor["gitService"] | undefined;
  snapshot: ConversationSnapshot;
  workspaceArgs: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  };
  target: OracleReviewTargetRef;
  reviewId: string;
}): Promise<OracleGatheredEvidence> {
  const fetchRowsBefore = async (beforeRowId: number, limit: number) =>
    params.agentService.conversationRowsRangeV4({
      ...params.workspaceArgs,
      sessionId: params.snapshot.sessionId,
      beforeRowId,
      limit,
    });
  // ── 目标轮完整材料 ──
  const bundle = await assembleOracleTurnMaterial({
    windowRows: params.snapshot.rows.window,
    header: params.target,
    fetchRowsBefore,
  });
  const completenessNotes = describeMaterialCompleteness(bundle.completeness);
  // ── 辅助证据：diff（只作辅助；读取失败不阻塞对话审查）──
  let sections = buildOracleDiffSections([]);
  let diffSource: "turn" | "workspace" | undefined;
  try {
    const fileChanges = await params.agentService.conversationFileChangesV4({
      ...params.workspaceArgs,
      sessionId: params.snapshot.sessionId,
      target: { rowId: params.target.rowId, entityId: params.target.entityId },
      baseRevision: params.snapshot.revision,
      baseLogEpoch: params.snapshot.logEpoch,
    });
    sections = buildOracleDiffSections(fileChanges.items);
    if (sections.length === 0) {
      // 常见原因：脚本/命令（Bash）完成的改动不会被 checkpoint 记录。
      const workspaceDiff = await readOracleWorkspaceDiff(
        params.gitService,
        params.workspaceArgs.workspacePath,
      );
      if (workspaceDiff.sections.length > 0) {
        sections = workspaceDiff.sections;
        diffSource = "workspace";
        // 工作区兜底 diff 有取数预算（文件数/字节）：被裁剪的事实必须进完整性
        // 说明，否则审查者会在「工作区实际状态」标题下按静默残缺的 diff 出结论。
        if (workspaceDiff.truncated || workspaceDiff.excluded > 0) {
          completenessNotes.push(
            `工作区 diff 证据被裁剪：已纳入 ${workspaceDiff.sections.length} 个文件` +
              `${workspaceDiff.excluded > 0 ? `，排除 ${workspaceDiff.excluded} 个（目录/依赖/内部目录）` : ""}` +
              `${workspaceDiff.truncated ? "，并因文件数或字节上限截断" : ""}。`,
          );
        }
      }
    } else {
      diffSource = "turn";
    }
  } catch (error) {
    completenessNotes.push("回合文件改动读取失败，本次审查未包含 diff 证据。");
    logger.warn("[OracleReview] diff 取数失败（审查继续）", {
      reviewId: params.reviewId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const recentCommits = await readOracleRecentCommitSubjects(
    params.gitService,
    params.workspaceArgs.workspacePath,
  );
  return {
    bundle,
    completenessNotes,
    sections,
    ...(diffSource ? { diffSource } : {}),
    recentCommits,
  };
}

export interface OracleAnalyzedContext {
  analysis: OracleContextAnalysis | null;
  /** 深度审查的更早相关轮次材料文本（相关轮次为空时缺席）。 */
  priorTurnsText?: string;
  taskScope?: {
    relatedTurnRowIds: readonly number[];
    candidateFilePaths: readonly string[];
  } | null;
  /** 分析层追加的完整性缺口（解析失败/降级说明）。 */
  completenessNotes: string[];
}

/**
 * 上下文分析步骤。深度审查下分析失败（请求失败**或输出无法解析**）直接抛 tagged
 * 错误——不得伪装成完整跨轮审查；标准审查降级为无前文继续，并在完整性说明里
 * 如实标注（含分析器自己报出的剔除/未校验缺口）。
 */
export async function analyzeOracleReviewContext(params: {
  agentService: NonNullable<ServiceAccessor["zcodeAgentService"]>;
  snapshot: ConversationSnapshot;
  workspaceArgs: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  };
  request: OracleReviewRequest;
  requestOptions: { selection: { providerId: string; modelId: string }; maxOutputTokens?: number };
  material: OracleTurnMaterial;
}): Promise<OracleAnalyzedContext> {
  const fetchRowsBefore = async (beforeRowId: number, limit: number) =>
    params.agentService.conversationRowsRangeV4({
      ...params.workspaceArgs,
      sessionId: params.snapshot.sessionId,
      beforeRowId,
      limit,
    });
  const { candidates, rows: candidateRows } = await collectContextCandidates({
    windowRows: params.snapshot.rows.window,
    cutoffRowId: params.request.target.rowId,
    fetchRowsBefore,
  });
  // 目标请求文本：只认非 guided 的真实用户输入（中途指导的 origin 同样是
  // realUser，选中它会把「改用方案 B」之类指导当成整轮主请求）。
  const realUserInputs = params.material.userInputs.filter((entry) => !entry.guided);
  const targetUserRequest =
    realUserInputs.find((entry) => entry.origin === "realUser")?.text ??
    realUserInputs[0]?.text ??
    "";
  const result: OracleAnalyzedContext = { analysis: null, taskScope: null, completenessNotes: [] };
  try {
    const analysisResult = await params.agentService.generateWorkspaceText({
      ...params.workspaceArgs,
      selection: params.requestOptions.selection,
      prompt: buildOracleContextAnalysisPrompt({
        targetHeaderRowId: params.request.target.rowId,
        targetUserRequest,
        candidatesText: renderContextCandidates(candidates),
        depth: params.request.depth,
      }),
      querySource: ORACLE_CONTEXT_ANALYSIS_QUERY_SOURCE,
      operationId: `${params.request.reviewId}:context`,
      stream: true,
      ...(params.requestOptions.maxOutputTokens !== undefined
        ? { maxOutputTokens: params.requestOptions.maxOutputTokens }
        : {}),
      requestTimeoutMs: ORACLE_CONTEXT_ANALYSIS_TIMEOUT_MS,
    });
    result.analysis = parseOracleContextAnalysis({
      raw: analysisResult.text,
      candidates,
      cutoffRowId: params.request.target.rowId,
      depth: params.request.depth,
    });
    if (!result.analysis) {
      // 解析失败（非 JSON 等）与请求失败同属「分析没做成」：深度审查必须同等
      // 报错，不能让「无任务范围」的假深度审查继续出结论（否则用户拿到的是
      // 一份伪装成跨轮核查的单轮审查）。
      if (params.request.depth === "deep") {
        const tagged = new Error("上下文分析输出无法解析，深度审查无法确定跨轮任务范围");
        tagged.name = CONTEXT_ANALYSIS_ERROR_NAME;
        throw tagged;
      }
      result.completenessNotes.push("上下文分析输出无法解析，本次审查未包含筛选后的前文。");
    } else {
      // 分析器自己产出的缺口（剔除的引用/未定位的引文）必须进入完整性说明：
      // 被剔除后 priorContext 可能缩水为空，审查者有权知道材料被裁过。
      result.completenessNotes.push(...result.analysis.notes);
    }
  } catch (error) {
    if ((error as Error | undefined)?.name === CONTEXT_ANALYSIS_ERROR_NAME) {
      throw error;
    }
    if (params.request.depth === "deep") {
      // 深度审查的任务范围识别失败时不得伪装成完整跨轮审查：
      // 如实报错，由用户重试或改用标准审查。
      const tagged = new Error(error instanceof Error ? error.message : String(error));
      tagged.name = CONTEXT_ANALYSIS_ERROR_NAME;
      throw tagged;
    }
    result.completenessNotes.push("上下文分析失败，本次审查未包含筛选后的前文。");
    logger.warn("[OracleReview] 上下文分析失败（标准审查降级继续）", {
      reviewId: params.request.reviewId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // ── 深度审查的更早相关轮次材料（rowId 已过代码校验）──
  const analysis = result.analysis;
  if (params.request.depth === "deep" && analysis && analysis.relatedTurnRowIds.length > 0) {
    const parts: string[] = [];
    for (const rowId of analysis.relatedTurnRowIds) {
      const headerRow = candidateRows.find(
        (row) => row.kind === "turnHeader" && row.rowId === rowId,
      );
      if (!headerRow || headerRow.kind !== "turnHeader") continue;
      const prior = extractTurnMaterialFromRows(
        {
          rowId,
          ...(headerRow.turnId ? { turnId: headerRow.turnId } : {}),
          ...(headerRow.productTurnId ? { productTurnId: headerRow.productTurnId } : {}),
        },
        candidateRows,
      );
      parts.push(renderOracleTurnMaterialText(prior.material, `回合 rowId=${rowId}`));
    }
    if (parts.length > 0) {
      result.priorTurnsText = parts.join("\n\n");
    }
    result.taskScope = {
      relatedTurnRowIds: analysis.relatedTurnRowIds,
      candidateFilePaths: analysis.candidateFilePaths,
    };
    logger.info("[OracleReview] 深度审查任务范围", {
      reviewId: params.request.reviewId,
      relatedTurnRowIds: analysis.relatedTurnRowIds,
      priorTurns: parts.length,
    });
  }
  return result;
}

/** 终态记录落盘（fire-and-forget 的同步发起段；失败只留痕，不影响结果展示）。 */
export function persistOracleReviewRecord(
  agentService: NonNullable<ServiceAccessor["zcodeAgentService"]>,
  params: {
    workspaceArgs: {
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    };
    sessionId: string;
    record: Parameters<
      NonNullable<ServiceAccessor["zcodeAgentService"]>["saveOracleReviewRecord"]
    >[0]["record"];
  },
): void {
  void agentService
    .saveOracleReviewRecord({
      ...params.workspaceArgs,
      sessionId: params.sessionId,
      record: params.record,
    })
    .then((saved: { saved: boolean }) => {
      if (!saved.saved) {
        logger.warn("[OracleReview] 审查记录未落盘（存储面缺席或写入失败）", {
          reviewId: params.record.reviewId,
        });
      }
    })
    .catch((error: unknown) => {
      logger.warn("[OracleReview] 审查记录保存失败", {
        reviewId: params.record.reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
