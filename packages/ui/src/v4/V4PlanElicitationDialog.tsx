// v4 userInput 交互的 ElicitationDialog 承载（从 V4InteractionDialogs 拆出控制其行数）。
// 投影/Bot 代答覆盖/交互分类仍在宿主完成，这里只负责渲染与应答组装。
// 计划批准（ExitPlanMode）复用问答卡片，并在这里挂上「执行模型/推理档」选择：
// 批准 + 指定模型经 resolveInteraction answer.modelSelection 单命令原子到达 CLI。
import type { ZCodeElicitationRequest } from "@zcode/shared";
import type { InteractionAutoResolution } from "@zcode/shared/zcode-protocol-v4";
import {
  ElicitationDialog,
  type PlanExecutionModelChoice,
  type PlanExecutionModelGroup,
} from "@/ElicitationDialog.js";
import type { ElicitationFormDraft } from "@/store/zcodeSessionStoreTypes.js";

/** 把已投影的 elicitation 请求接进 ElicitationDialog。 */
export function V4PlanElicitationDialog(props: {
  request: ZCodeElicitationRequest;
  autoResolution?: InteractionAutoResolution;
  botElicitationProgress: ZCodeElicitationRequest | null;
  localElicitationDraft?: ElicitationFormDraft;
  persistElicitationDraft: (requestId: string, draft: ElicitationFormDraft) => void;
  removeElicitationDraft: (requestId: string) => void;
  /** 执行模型下拉候选；仅 plan-approval 传入，空数组同样隐藏下拉。 */
  planExecutionModelGroups?: PlanExecutionModelGroup[];
  /** AskUserQuestion 首次交互暂停（自动结束倒计时）宿主侧闭包，原样转交。 */
  onFirstInteraction?: (
    source: "panelHover" | "answer" | "navigation" | "countdown",
  ) => boolean | void | Promise<boolean | void>;
  resolveInteraction: (
    interactionId: string,
    answer: {
      optionId?: string;
      freeText?: string;
      action?: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
      modelSelection?: PlanExecutionModelChoice;
    },
  ) => Promise<boolean>;
  onPlanInteractionAccepted?: (interactionId: string) => void;
}) {
  const {
    request,
    autoResolution,
    botElicitationProgress,
    localElicitationDraft,
    persistElicitationDraft,
    removeElicitationDraft,
    planExecutionModelGroups,
    onFirstInteraction,
    resolveInteraction,
    onPlanInteractionAccepted,
  } = props;
  return (
    <ElicitationDialog
      key={`${request.requestId}:${request.currentQuestionIndex ?? 0}:${JSON.stringify(request.answerDrafts ?? {})}`}
      request={request}
      initialFormDraft={
        botElicitationProgress?.requestId === request.requestId ? undefined : localElicitationDraft
      }
      onFormDraftChange={persistElicitationDraft}
      planExecutionModelGroups={planExecutionModelGroups}
      autoResolution={autoResolution}
      onFirstInteraction={onFirstInteraction}
      onRespond={(_requestId, action, content, executionModel) => {
        void resolveInteraction(request.requestId, {
          action,
          ...(content ? { content } : {}),
          // 批准 + 指定执行模型：单命令原子到达（CLI broker 据此合并 modify 输入）。
          ...(action === "accept" && executionModel
            ? {
                modelSelection: {
                  providerId: executionModel.providerId,
                  modelId: executionModel.modelId,
                  ...(executionModel.reasoningLevel
                    ? { options: { reasoningLevel: executionModel.reasoningLevel } }
                    : {}),
                },
              }
            : {}),
        }).then((accepted) => {
          if (!accepted) return;
          removeElicitationDraft(request.requestId);
          // Plan 回执 ACK 与 replayable pending 清场是两条异步路径。
          // 这里只上报已接受的 Plan interaction，由手机 pane 在仍读到旧权威状态时触发恢复。
          onPlanInteractionAccepted?.(request.requestId);
        });
      }}
    />
  );
}
