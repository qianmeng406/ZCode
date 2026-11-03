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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/lib/utils.js";
import { ExternalAgentActivityCard } from "@/v4/composer/ExternalAgentActivityCard.js";
import {
  getExternalAgentActivity,
  subscribeExternalAgentActivity,
} from "@/v4/externalAgent/externalAgentActivityStore.js";

export interface ExternalAgentActivityCardSlotProps {
  sessionId: string | null;
  /** 打开右侧过程面板；缺席时卡片不显示「查看过程」。 */
  onOpenPanel?: (taskId: string) => void;
  className?: string;
}

const NOOP_UNSUBSCRIBE = (): void => {};

export function ExternalAgentActivityCardSlot({
  sessionId,
  onOpenPanel,
  className,
}: ExternalAgentActivityCardSlotProps) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? subscribeExternalAgentActivity(sessionId, listener) : NOOP_UNSUBSCRIBE,
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? getExternalAgentActivity(sessionId) : null),
    [sessionId],
  );
  const activity = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [dismissedTaskId, setDismissedTaskId] = useState<string | null>(null);
  // 新任务出现时清掉上次的关闭状态：否则同一会话的第二次委派会"永远不显示"。
  useEffect(() => {
    if (activity && dismissedTaskId && activity.taskId !== dismissedTaskId) {
      setDismissedTaskId(null);
    }
  }, [activity, dismissedTaskId]);

  if (!activity || activity.taskId === dismissedTaskId) return null;
  return (
    <div className={cn("flex w-full justify-center", className)}>
      <ExternalAgentActivityCard
        activity={activity}
        onDismiss={setDismissedTaskId}
        {...(onOpenPanel ? { onOpen: onOpenPanel } : {})}
      />
    </div>
  );
}
