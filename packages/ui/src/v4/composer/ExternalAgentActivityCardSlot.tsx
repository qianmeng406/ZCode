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
// 注意力：只有"看着它从 running 变成终态"才算看到了。切走期间完成的任务，
// 回到会话时才第一次见到终态帧（离开期间没有订阅），此时要保留未读点——
// 否则"跑完没"这件事在返回的一瞬间就被悄悄销掉，用户永远看不到提示。
// 打开过程面板是显式动作，那里会无条件销未读。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

  // 看得见的终态转换 = 已看：同一 taskId 从 running 变 completed/failed/cancelled。
  const previousRef = useRef<typeof activity>(null);
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = activity;
    if (!sessionId || !visible || !activity || activity.status === "running") return;
    // 首次挂载就已经是终态（完成发生在切走期间）→ 保留未读，返回时还能看到提示。
    if (previous?.status !== "running" || previous.taskId !== activity.taskId) return;
    markExternalAgentActivitySeen(sessionId, activity.taskId);
  }, [sessionId, visible, activity]);

  if (!activity || activity.taskId === dismissedTaskId) return null;
  return (
    <div className={cn("flex w-full justify-center", className)}>
      <ExternalAgentActivityCard
        activity={activity}
        lastChangedAt={state.lastChangedAt}
        onDismiss={setDismissedTaskId}
        {...(onOpenPanel ? { onOpen: onOpenPanel } : {})}
      />
    </div>
  );
}
