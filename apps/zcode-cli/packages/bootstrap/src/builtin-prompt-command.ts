import { join } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";
export const ZCODE_UPDATE_COMMAND_NAME = "zcode-update";

export interface ResolveZCodeBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export interface ResolvedZCodeBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveZCodeBuiltinPromptCommand(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveZCodeBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveZCodeBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): ResolvedZCodeBuiltinPromptCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return {
      name: INIT_COMMAND_NAME,
      prompt: buildInitAgentsPrompt({
        args: invocation.args,
        targetPath: join(workingDirectory, "AGENTS.md"),
        workingDirectory,
      }),
    };
  }

  if (invocation.name === ZCODE_UPDATE_COMMAND_NAME) {
    return buildZCodeUpdatePrompt({
      args: invocation.args,
      workingDirectory: options.workingDirectory ?? process.cwd(),
    });
  }

  if (invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    return {
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
      prompt: expandBuiltinWorkflowCommandPrompt(invocation.args),
    };
  }

  return undefined;
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? [
        "",
        "Additional user instructions supplied with /init:",
        "```text",
        params.args,
        "```",
      ].join("\n")
    : "";

  return [
    "You are running ZCode's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ZCode agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file: ${params.targetPath}`,
    `- Existing hidden instruction candidates: ${join(params.workingDirectory, ".zcode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.zcode/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. First check whether .zcode/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future ZCode agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}

/**
 * `/zcode-update`：跟进官方 ZCode 发版的专用维护任务。
 *
 * 只展开为一次普通 agent turn，不改权限模式、不偷偷切 yolo/minimal：命令与文件修改的
 * 确认策略仍由当前会话模式决定。硬边界（不 pull/merge/cherry-pick/push、破坏性 git 操作
 * 单次确认）由权限层 AST 判定强制，这里只负责流程与证据要求。
 */
function buildZCodeUpdatePrompt(params: { args: string; workingDirectory: string }): string {
  const additionalInstructions = params.args
    ? ["", "Additional user instructions supplied with /zcode-update:", "```text", params.args, "```"].join(
        "\n",
      )
    : "";

  return [
    "You are running ZCode's built-in /zcode-update command.",
    "",
    "Your task: track upstream ZCode releases and land the changes that matter to this local fork as local modifications, then verify them. This is a long-running maintenance task; keep the ledger as the single source of progress.",
    "",
    `Workspace: ${params.workingDirectory}`,
    additionalInstructions,
    "",
    "## 0. Preflight (do this first; stop if it fails)",
    "",
    "1. Confirm this is a non-bare git worktree with a resolvable top-level and HEAD (support `.git` file worktrees).",
    "2. Verify the effective `origin` fetch URL really points at the upstream ZCode repository; account for URL rewrite/transport config. If it does not match, STOP and ask the user which remote is authoritative — never change remotes yourself.",
    "3. Record the current local HEAD. It is NOT the upstream baseline.",
    "4. Detect uncommitted changes. Dirty worktree: analysis (S1/S2) is allowed, but do NOT edit code (S3) until the user resolves the existing changes. Never stash/reset/clean/commit them yourself.",
    "5. For network problems, report the real cause (proxy/DNS/auth/TLS/timeout) — do not claim a generic proxy problem and never modify global git proxy config.",
    "",
    "## 1. Inventory (S1)",
    "",
    "- `git ls-remote --tags origin` to verify connectivity; on failure STOP and report the exact error.",
    "- `git fetch origin --tags` (fetch only; it writes objects/refs and needs a confirmation when prompted).",
    "- List the version range between the recorded upstream baseline and the target tags (resolve each tag to a full commit SHA) and write it into the ledger. If no baseline is recorded, propose candidates and ask the user to confirm one — never guess.",
    "",
    "## 2. Analyze (S2)",
    "",
    "For each version: `git diff <prev>..<next> --stat` first, then read what matters. Classify by layer and judge relevance:",
    "- overlap with files we already modified locally (future rebase conflict sources — call these out);",
    "- fixes for problems this fork also has;",
    "- impact on locally delivered features (minimal context profile, minimal mode, the update mode itself).",
    "",
    "## 3. Land (S3)",
    "",
    "For relevant items, re-implement as local changes. Never cherry-pick or merge upstream commits; never pull/push (these are blocked). Record for each item: upstream change -> local implementation -> files touched. Record irrelevant items with a reason and touch nothing.",
    "",
    "## 4. Verify (S4)",
    "",
    "Run the gates that match what you changed and record the actual command and exit status in the ledger:",
    "- root: `pnpm typecheck`, `pnpm exec oxlint`, `pnpm exec oxfmt --check`, `pnpm architecture:check -- --changed`;",
    "- changes under apps/zcode-cli: `pnpm --dir apps/zcode-cli check`, `lint`, `format:check` (the root typecheck/lint do NOT cover the CLI workspace);",
    "- relevant package tests (`npx tsx --test <pkg>/test/*.test.ts`, UI tests need `--tsconfig packages/ui/tsconfig.json`).",
    "A gate that failed, timed out, or was skipped must be recorded as such. Never write \"passed\" without running it, and never present gate success as proof the feature works.",
    "",
    "## Ledger",
    "",
    "Maintain `zcode-update/更新台账.md` with a machine-readable marker line `<!-- zcode-update v1 stage:S1 -->` (stage = S1/S2/S3/S4) plus one section per version: version/tag SHA, commit range, analysis conclusion, landed items and files, gate results.",
    "",
    "## Hard boundaries (also enforced by the permission layer)",
    "",
    "- Never `git pull/merge/cherry-pick/push/rebase` — they are denied outright.",
    "- Destructive git operations (`reset --hard`, `clean`, force checkout/restore, `rm`, `stash drop/clear`, `worktree remove`, `branch -D`, `tag -d`) require explicit user confirmation even when the session runs with automatic permissions.",
    "- Only modify files relevant to the current item; do not refactor unrelated code.",
    "- When upstream and local changes conflict and the right trade-off is unclear, stop and ask the user — that decision is theirs.",
    "- Never fabricate analysis conclusions or gate results; if you cannot get a diff, say so.",
  ].join("\n");
}
