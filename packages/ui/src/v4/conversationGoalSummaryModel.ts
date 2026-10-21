import type { GoalState } from "@zcode/shared/zcode-protocol-v4";

const INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION =
  "Continue verifying and completing the goal.";

export interface ConversationGoalIterationSummary {
  iteration: number;
  title: string | null;
  items: GoalState["iterations"][number]["items"];
  completedCount: number;
  totalCount: number;
  completed: boolean;
  verificationOutcome: GoalState["verifications"][number]["outcome"] | null;
}

function visibleNextAction(value: string | undefined): string | null {
  const nextAction = value?.trim();
  if (!nextAction || nextAction === INTERNAL_GOAL_VERIFICATION_FALLBACK_NEXT_ACTION) {
    return null;
  }
  return nextAction;
}

function requiredIterationCount(goal: GoalState): number {
  const maxTodoIteration = (goal.iterations ?? []).reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
  const maxVerificationIteration = goal.verifications.reduce(
    (maximum, entry) => Math.max(maximum, entry.iteration),
    0,
  );
  const latestVerification = goal.verifications.findLast(
    (entry) => entry.iteration === goal.iteration,
  );
  const continuationIsOpen =
    goal.status === "active" ||
    goal.status === "notSatisfied" ||
    (goal.status === "paused" && latestVerification?.outcome === "notSatisfied");
  const statusIteration = continuationIsOpen ? goal.iteration + 1 : Math.max(1, goal.iteration);
  return Math.max(1, statusIteration, maxTodoIteration, maxVerificationIteration);
}

/** 从 V4 权威 goal 投影构造右上角逐轮摘要；不从 renderer timeline 反推轮次。 */
export function buildConversationGoalIterationSummaries(
  goal: GoalState,
): ConversationGoalIterationSummary[] {
  const todoByIteration = new Map(
    (goal.iterations ?? []).map((entry) => [entry.iteration, entry.items] as const),
  );
  const verificationByIteration = new Map(
    goal.verifications.map((entry) => [entry.iteration, entry] as const),
  );
  const rows: ConversationGoalIterationSummary[] = [];

  for (let iteration = 1; iteration <= requiredIterationCount(goal); iteration += 1) {
    const items = todoByIteration.get(iteration) ?? [];
    const completedCount = items.filter((item) => item.status === "completed").length;
    const previousVerification = verificationByIteration.get(iteration - 1);
    rows.push({
      iteration,
      title:
        iteration === 1
          ? goal.summaryTitle?.trim() || goal.objective.trim() || null
          : visibleNextAction(previousVerification?.nextAction),
      items,
      completedCount,
      totalCount: items.length,
      completed: items.length > 0 && completedCount >= items.length,
      verificationOutcome: verificationByIteration.get(iteration)?.outcome ?? null,
    });
  }

  return rows.sort((left, right) => {
    if (left.completed !== right.completed) return left.completed ? -1 : 1;
    return left.iteration - right.iteration;
  });
}

/**
 * 当前未完成行 = 最大未完成 iteration。paused + notSatisfied 时
 * requiredIterationCount 会生成 goal.iteration + 1，不能用 iteration === goal.iteration 判定。
 */
export function getCurrentOpenGoalIteration(
  rows: readonly ConversationGoalIterationSummary[],
): number {
  return rows.reduce(
    (current, row) => (!row.completed && row.iteration > current ? row.iteration : current),
    -1,
  );
}

export function getConversationGoalElapsedSeconds(goal: GoalState, now: number): number {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds ?? 0));
  const isRunning =
    goal.status === "active" || goal.status === "verifying" || goal.status === "notSatisfied";
  if (!isRunning || goal.activeRunStartedAtMs == null) return baseSeconds;
  return baseSeconds + Math.max(0, Math.floor((now - goal.activeRunStartedAtMs) / 1000));
}

/**
 * 目标迭代行「继续」动作的纯裁决。
 *
 * 面板里的迭代行是 goal 的历史展开，不是独立目标：
 * - 当前未完成行（最大未完成 iteration）才代表“正在做的这件事”；
 *   paused → resume（保留历史/进度），notSatisfied → continue（不换目标、不重置进度），
 *   active/verifying → already-running（已在执行）。
 * - 历史/已完成行只能“从这条重新开始”：以该行标题替换目标，进度会重置。
 * - Plan 与 Goal 互斥，任何分支都先被 blocked-plan 拦下。
 */
export type GoalIterationAction =
  | "blocked-plan"
  | "resume"
  | "continue"
  | "already-running"
  | "restart"
  | "noop";

export function resolveGoalIterationAction(input: {
  planEnabled: boolean;
  goalStatus: GoalState["status"];
  isCurrentOpenRow: boolean;
  hasTitle: boolean;
}): GoalIterationAction {
  if (input.planEnabled) return "blocked-plan";
  if (input.isCurrentOpenRow) {
    if (input.goalStatus === "paused") return "resume";
    if (input.goalStatus === "notSatisfied") return "continue";
    if (input.goalStatus === "active" || input.goalStatus === "verifying") {
      return "already-running";
    }
    return input.hasTitle ? "restart" : "noop";
  }
  return input.hasTitle ? "restart" : "noop";
}
