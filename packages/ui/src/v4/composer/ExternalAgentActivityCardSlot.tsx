// 状态卡的宿位：负责"什么时候显示"，卡片本身只管渲染。
//
// 数据源是模块级 store（与右侧过程面板同源），不是投影快照直传：
// 投影在冷恢复 / 重订阅 / pane 重挂载的过渡帧里会给出 `externalAgentActivity: null`，
// 直传会让"刚跑完的记录"连同卡片一起消失。store 里完成态记录抗空值，
// 只有新任务开始或显式清除（解绑）才会被替换/清掉。
//
// 两个展示规则：
// - 同一 taskId 被用户关掉后不再自己弹回来（新任务 = 新 taskId，会重新出现）；
// - 没有活动（null）时不占任何高度，布局不抖。
//
// 注意力：未读只在"真的看过了"时销——
// - 卡片可见且这条未读来自**实时帧**（用户在看着它跑完）；
// - 用户关掉卡片（显式动作）。
// 切走期间完成的任务，返回时同样是 running→终态，但那一帧是重挂载补发的
// （`replayed`，见 store）：此时不能自动销，否则「跑完没」的提示在返回的
// 一瞬间就消失，用户永远看不到。打开过程面板也会销未读。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/lib/utils.js";
import { ExternalAgentActivityCard } from "@/v4/composer/ExternalAgentActivityCard.js";
import {
  getExternalAgentActivityState,
  markExternalAgentActivitySeen,
  subscribeExternalAgentActivity,
} from "@/v4/externalAgent/externalAgentActivityStore.js";

export interface ExternalAgentActivityCardSlotProps {
  sessionId: string | null;
  /** 打开右侧过程面板；缺席时卡片不显示「查看过程」。 */
  onOpenPanel?: (taskId: string) => void;
  /** 卡片是否真的在屏幕上（缺省 true）。隐藏的 forceMount 宿主传 false。 */
  visible?: boolean;
  className?: string;
}

const NOOP_UNSUBSCRIBE = (): void => {};

export function ExternalAgentActivityCardSlot({
  sessionId,
  onOpenPanel,
  visible = true,
  className,
}: ExternalAgentActivityCardSlotProps) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeExternalAgentActivity(sessionId, listener) : NOOP_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(() => getExternalAgentActivityState(sessionId), [sessionId]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const activity = state.activity;

  const [dismissedTaskId, setDismissedTaskId] = useState<string | null>(null);
  // 新任务出现时清掉上次的关闭状态：否则同一会话的第二次委派会"永远不显示"。
  useEffect(() => {
    if (activity && dismissedTaskId && activity.taskId !== dismissedTaskId) {
      setDismissedTaskId(null);
    }
  }, [activity, dismissedTaskId]);

  // 只在"实时看着它跑完"时自动销未读；replayed 帧（切走期间完成）留着。
  useEffect(() => {
    if (!sessionId || !visible || !activity || activity.status === "running") return;
    if (state.unreadTaskId !== activity.taskId || !state.unreadLive) return;
    markExternalAgentActivitySeen(sessionId, activity.taskId);
  }, [sessionId, visible, activity, state]);

  // 关掉卡片是显式动作：等同于"我看到了"。
  const handleDismiss = useCallback(
    (taskId: string) => {
      setDismissedTaskId(taskId);
      if (sessionId) markExternalAgentActivitySeen(sessionId, taskId);
    },
    [sessionId],
  );

  if (!activity || activity.taskId === dismissedTaskId) return null;
  return (
    <div className={cn("flex w-full justify-center", className)}>
      <ExternalAgentActivityCard
        activity={activity}
        lastChangedAt={state.lastChangedAt}
        onDismiss={handleDismiss}
        {...(onOpenPanel ? { onOpen: onOpenPanel } : {})}
      />
    </div>
  );
}
