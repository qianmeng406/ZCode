import { analyzeBashCommand, isBashCommandPermissionSafe } from "./bash-command-parser.js";

/**
 * 旧极简自动权限（minimal）的命令级边界。
 *
 * 该模式自动放行普通命令与文件修改，「破坏性操作、写远端、状态改写先确认」若只写在
 * 提示词里，就是模型纪律而不是执行边界。这里按 Bash AST/argv 判定，权限服务在模式
 * 放行分支前调用；Hook 改写输入后的 recheck 也走同一入口。
 * 强制范围：reset --hard、clean、覆盖性 checkout/restore、rm、任意 stash、任意 commit、
 * fetch、pull/merge/cherry-pick/push/rebase 等单次确认。
 *
 * 注：ZCode 更新模式（zcodeUpdate）连同其「pull/merge/cherry-pick/push/rebase 硬 deny」
 * 禁令已随模式移除；fork 版本更新改走 docs/upstream-sync.md 的常规上游合并流程。
 *
 * 已知边界（如实声明）：只覆盖 Bash 工具里的显式 git 调用。别名、脚本文件、Python/插件
 * 内部的 git 调用无法静态识别；复杂 shell（动态词/解析失败/不支持节点）不自动授权。
 */

export type UpdateTaskCommandDecision = "allow" | "ask";

/** 写远端或并入外部历史的 git 操作：不自动执行，单次确认后由用户显式放行。 */
const UPDATE_FORBIDDEN_GIT_SUBCOMMANDS = new Set([
  "pull",
  "merge",
  "cherry-pick",
  "push",
  "rebase",
]);

/** 需要单次确认的 git 操作：破坏性/覆盖性操作，以及更新边界「不自动 stash / commit」的状态改写。 */
const CONFIRM_GIT_SUBCOMMANDS = new Set([
  "reset",
  "clean",
  "checkout",
  "restore",
  "rm",
  "stash",
  "worktree",
  "branch",
  "tag",
  "am",
  // 更新边界明确「不自动提交」：commit 无安全变体，任何形式都单次确认。
  "commit",
]);

function resolveGitSubcommand(argv: readonly string[]): string | undefined {
  // argv[0] 是 git 自身；跳过全局选项（-C/-c/--git-dir 等）与其取值，取第一个操作数。
  // 全局选项不放宽判定：`git -C elsewhere push` 同样命中 push。
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") return argv[index + 1];
    if (arg.startsWith("-")) {
      // 形如 -C<path> 的黏连写法没有独立取值；其余选项可能吃掉下一个参数。
      if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

function needsConfirmationGitInvocation(argv: readonly string[]): boolean {
  const subcommand = resolveGitSubcommand(argv);
  if (!subcommand) return false;
  if (subcommand === "reset") {
    // reset --soft/--mixed 不丢工作区内容；--hard 丢。
    return argv.includes("--hard");
  }
  if (subcommand === "branch") return argv.includes("-D") || argv.includes("-f");
  if (subcommand === "tag") return argv.includes("-d") || argv.includes("-f");
  if (subcommand === "stash") {
    // 任意 stash 形式都确认：plain stash 会把未提交改动收进 stash（更新边界「不自动
    // stash」），drop/clear 还会销毁数据。不能只拦 drop/clear。
    return true;
  }
  if (subcommand === "worktree") return argv.some((arg) => arg === "remove" || arg === "prune");
  return CONFIRM_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * 判定一次 Bash 调用在旧极简自动权限边界下的行为：
 * 破坏性/写远端/状态改写类 git 操作降为 ask；无法可靠解析的命令一律 ask
 * （不自动放行，要求拆成明确形式或正常确认）。
 */
export function resolveUpdateTaskCommandDecision(input: unknown): UpdateTaskCommandDecision {
  if (!input || typeof input !== "object") return "ask";
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim().length === 0) return "ask";

  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis)) return "ask";

  let decision: UpdateTaskCommandDecision = "allow";
  for (const invocation of analysis.commands) {
    if (invocation.name !== "git") continue;
    const subcommand = resolveGitSubcommand(invocation.argv);
    if (!subcommand) return "ask";
    if (
      needsConfirmationGitInvocation(invocation.argv) ||
      subcommand === "fetch" ||
      // 写远端/并入外部历史不自动执行，单次确认后由用户显式放行。
      UPDATE_FORBIDDEN_GIT_SUBCOMMANDS.has(subcommand)
    ) {
      // 破坏性/覆盖性操作、fetch（写 refs/objects + 网络）以及「不自动 stash / commit」
      // 边界涉及的状态改写都走单次确认：fetch 不是只读操作，stash/commit 也不因自动执行
      // 模式而静默放行。
      decision = "ask";
      continue;
    }
  }
  return decision;
}
