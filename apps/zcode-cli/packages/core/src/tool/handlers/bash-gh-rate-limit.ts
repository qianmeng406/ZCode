const GH_RATE_LIMIT_HINT_COOLDOWN_MS = 60_000;
const GH_COMMAND_RE =
  /(?:^|[;&|]|\b(?:then|do)\b)\s*gh\s+(?!auth\b|help\b|version\b|alias\b|completion\b|config\b)/;
const GH_RATE_LIMIT_RE =
  /API rate limit (?:already )?exceeded|exceeded a secondary rate limit|\bRATE_LIMITED\b/i;
let nextGhRateLimitHintAt = 0;

/**
 * 限流提示。
 *
 * 修复原因（2026-11-18，B1-08）：原先固定推荐 `ScheduleWakeup`，但那个工具**根本没有
 * handler**（只在 provider-visible-order 的排序名单里），模型照着调用必然 ToolNotFound。
 * 方案要求「提示、schema、权限、注册、执行环境一致；不可用工具给出当前能力下的安全
 * 退出或等待路径」。
 *
 * `availableTools` 由调用方按当前注册表传入时，才可能点名等待类工具；拿不到注册表
 * （Bash handler 的 context 不含 registry）时给不依赖任何工具的行动路径——宁可不提工具，
 * 也不点名一个可能不存在的工具。
 */
export function buildGhRateLimitHint(availableTools?: ReadonlySet<string>): string {
  const head =
    "GitHub API rate limit exceeded (5,000/hr shared across all tools and agents). Run `gh api rate_limit --jq .resources` and wait until reset before further gh calls.";
  if (availableTools?.has("Monitor")) {
    return `<system-reminder>${head} If you are polling in a loop, use Monitor to wait for the condition instead of retrying.</system-reminder>`;
  }
  if (availableTools?.has("CronCreate")) {
    return `<system-reminder>${head} CronCreate schedules durable tasks — it is not for in-turn waiting; otherwise just wait and retry.</system-reminder>`;
  }
  // 没有等待类工具可用：只给不依赖工具的行动路径，不虚构工具名。
  return `<system-reminder>${head} Wait (sleep) before retrying; do not poll in a tight loop.</system-reminder>`;
}

export function getGhRateLimitHint(
  command: string,
  output: string,
  availableTools?: ReadonlySet<string>,
): string | undefined {
  if (!GH_COMMAND_RE.test(command) || !GH_RATE_LIMIT_RE.test(output)) return undefined;
  const now = Date.now();
  if (now < nextGhRateLimitHintAt) return undefined;
  nextGhRateLimitHintAt = now + GH_RATE_LIMIT_HINT_COOLDOWN_MS;
  return buildGhRateLimitHint(availableTools);
}

/** 测试用：重置冷却，避免用例之间互相压制。 */
export function resetGhRateLimitHintCooldownForTest(): void {
  nextGhRateLimitHintAt = 0;
}
