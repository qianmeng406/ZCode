// 状态卡的宿位：负责"什么时候显示"，卡片本身只管渲染。
//
// 两个规则：
// - 同一 taskId 被用户关掉后不再自己弹回来（新任务 = 新 taskId，会重新出现）；
// - 没有活动（null）时不占任何高度，布局不抖。
import { useEffect, useState } from "react";
import type { ExternalAgentActivity } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { ExternalAgentActivityCard } from "@/v4/composer/ExternalAgentActivityCard.js";

export interface ExternalAgentActivityCardSlotProps {
  activity: ExternalAgentActivity | null;
  /** 打开右侧过程面板；缺席时卡片不显示「查看过程」。 */
  onOpenPanel?: (taskId: string) => void;
  className?: string;
}

export function ExternalAgentActivityCardSlot({
  activity,
  onOpenPanel,
  className,
}: ExternalAgentActivityCardSlotProps) {
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
