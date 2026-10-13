import { useEffect, useState } from "react";
import type { ConversationSnapshot, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  appendOracleReviewToolEvent,
  isOracleReviewQuerySource,
  type OracleReviewState,
} from "./oracleReviewSupport.js";
import { isOracleReviewableTurnState } from "./oracleReviewMaterial.js";
import { getOracleReviewState, setOracleReviewState } from "./oracleReviewStore.js";

/**
 * 最近一个**可审查**回合的 header：手动「审查」按钮默认审它。
 * 可审查 = 非运行中的对话终态（成功/被中断/失败）且非 controlOnly——失败与中断
 * 本身是被审查对象；不再要求有文件改动（纯对话回合同样可审）。
 */
export function findLastReviewableTurnHeader(
  snapshot: ConversationSnapshot,
): TurnHeaderRow | null {
  for (let index = snapshot.rows.window.length - 1; index >= 0; index -= 1) {
    const row = snapshot.rows.window[index];
    if (
      row?.kind === "turnHeader" &&
      row.executionKind !== "controlOnly" &&
      isOracleReviewableTurnState(row.state)
    ) {
      return row;
    }
  }
  return null;
}

type OracleServices = ReturnType<typeof useOptionalServices>;

/**
 * pending 期间的进度反馈（从主 hook 拆出，控制其行数）：
 * - 等待时长：pending 期间每秒跳一次，让用户确认「还在跑」。
 * - 流式输出进度：CLI 把正文+思考的累计字符数（深度审查附轮次/工具名）按节流窗口
 *   推给宿主，经 onDynamicWorkspaceGenerateTextProgress 全局事件转发到这里。
 *   路由优先按 pending 态保存的 operationId 精确认领（审查的上下文分析/正式审查
 *   阶段各持一个；同 workspace 多会话并发审查不串线）；operationId 缺席（旧 CLI
 *   不回显）才退回 querySource+workspacePath 认领。
 * 轮次/工具名/工具事件直接写进模块级 store 的 pending 条目，主 hook 无需逐帧重渲染。
 */
export function useOracleReviewPendingProgress(params: {
  state: OracleReviewState;
  services: OracleServices | null;
  workspacePath: string;
  sessionId: string | null;
}): { pendingElapsedSeconds: number; pendingOutputChars: number } {
  const { state, services, workspacePath, sessionId } = params;

  const [pendingElapsedSeconds, setPendingElapsedSeconds] = useState(0);
  // 起始时间读 store 里的 pending.startedAt（请求发起时写入）：组件随会话切换
  // 卸载重建时计时不重置——之前挂 React ref，重挂载即归零，表现为「切走再切回，
  // 已等待从 0:00 重新跳」。阶段推进经 ...current 合并，startedAt 自然保留。
  const pendingStartedAt = state.status === "pending" ? state.startedAt : null;
  useEffect(() => {
    if (pendingStartedAt === null) {
      setPendingElapsedSeconds(0);
      return;
    }
    const tick = () => {
      setPendingElapsedSeconds(Math.max(0, Math.round((Date.now() - pendingStartedAt) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pendingStartedAt]);

  const [pendingOutputChars, setPendingOutputChars] = useState(0);
  // operationId 只在 pending 态存在；提升到 effect 外做联合收窄，effect 依赖它即可
  // 在阶段切换（context→review）时重建订阅。reviewId 是 reviewId 前缀过滤的键。
  const pendingOperationId = state.status === "pending" ? state.operationId : undefined;
  const pendingReviewId = state.status === "pending" ? state.reviewId : undefined;
  useEffect(() => {
    if (state.status !== "pending") {
      setPendingOutputChars(0);
      return;
    }
    const expectedOperationIdStatic = pendingOperationId;
    const expectedReviewIdStatic = pendingReviewId;
    const event = services?.zcodeAgentService.onDynamicWorkspaceGenerateTextProgress();
    if (!event) {
      return;
    }
    const disposable = event((progress) => {
      if (expectedOperationIdStatic) {
        if (progress.operationId !== expectedOperationIdStatic) return;
      } else if (progress.operationId && expectedReviewIdStatic) {
        // collecting 阶段还没有自己的 operationId，但事件自带来源:阶段后缀：
        // 按本审查的 reviewId 前缀认领，避免同 workspace 另一会话的进度串入。
        if (!progress.operationId.startsWith(`${expectedReviewIdStatic}:`)) return;
      } else {
        if (!isOracleReviewQuerySource(progress.querySource)) return;
        if (progress.workspacePath !== workspacePath) return;
      }
      setPendingOutputChars(progress.outputChars);
      // 深度审查的轮次/工具名/工具事件写进 store 的 pending 条目（工具执行阶段带
      // toolName，生成阶段不带——直接赋值让上一次的工具名随新轮次清空）。
      const hasToolEvent = Boolean(progress.toolName);
      if (sessionId !== null && (progress.round !== undefined || hasToolEvent)) {
        const current = getOracleReviewState(sessionId);
        if (current.status === "pending") {
          const toolEvents =
            hasToolEvent && progress.toolName
              ? appendOracleReviewToolEvent(current.toolEvents ?? [], {
                  round: progress.round ?? current.round ?? 1,
                  toolName: progress.toolName,
                  ...(progress.toolTarget ? { target: progress.toolTarget } : {}),
                })
              : current.toolEvents;
          setOracleReviewState(sessionId, {
            ...current,
            ...(progress.round !== undefined ? { round: progress.round } : {}),
            toolName: progress.toolName,
            toolTarget: progress.toolTarget,
            ...(toolEvents ? { toolEvents } : {}),
          });
        }
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [state.status, pendingOperationId, pendingReviewId, services, workspacePath, sessionId]);

  return { pendingElapsedSeconds, pendingOutputChars };
}
