import type {
  ModelInputMessage,
  ModelRequest,
  Model,
  ModelToolCall,
  ModelUsage,
  TraceContext,
} from "../deps.js";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runToolAgentLoop } from "../../memory/memory-agent-loop.js";
import { isRuntimeReadOnlyBashCommand } from "../../tool/handlers/bash-semantics.js";
import { getSessionShellSelectionFromConfig } from "./session-shell-environment.js";
import {
  streamModelTextResult,
  type WorkspaceGenerateTextProgress,
} from "./workspace-generate-text.js";

/**
 * 深度审查循环：会话外的只读子代理。审查方拿到 Read/Grep/Glob 与只读 Bash
 * （写命令在 tool-use 边界被只读分类器硬拒），多轮取证后产出与标准审查同格式
 * 的 VERDICT/SUMMARY/FINDINGS 结论。骨架复用 runToolAgentLoop（memory agent
 * 提取的通用循环），只读策略与模型选项在本地注入。
 */

const DEEP_REVIEW_ALLOWED_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
// 多轮取证的轮数上限：一次「读若干文件 + 搜索 + 汇总」通常 <10 轮，24 留足余量；
// 达到上限即以最后一轮正文收尾（解析不到结论会走 empty-response 错误卡片）。
const DEEP_REVIEW_MAX_TURNS = 24;
// 收尾轮：轮次用尽时最后一轮常是「工具调用收尾、没有正文」，直接返回会让 UI 报
// 空正文错误并丢掉整轮调查。此时追加一次禁用工具的收尾生成，强制模型给出结论。
const DEEP_REVIEW_WRAP_UP_INSTRUCTION =
  "轮次预算已用尽。请基于以上已完成的调查直接给出最终结论，不要再调用任何工具——你没有可用工具，只输出最终结论正文（按任务要求的规定格式）。";
// 调查时间触顶的收尾指令：与轮数用尽同构，但明确告知剩余时间不足，
// 结论允许标注「因时间所限未核实」，不允许编造未取证的说法。
const DEEP_REVIEW_DEADLINE_WRAP_UP_INSTRUCTION =
  "调查时间即将用尽，不能再继续取证。请基于以上已完成的调查立即给出最终结论，不要再调用任何工具——你没有可用工具，只输出最终结论正文（按任务要求的规定格式）。未能核实的点在结论中如实标注「因时间所限未核实」，不要臆断。";
// 收尾轮自身是一次完整生成（慢渠道可达数分钟），必须预留总预算的相当比例，
// 否则调查轮把时间耗光、收尾轮刚起步就被外层 hard-abort，整段审查零结论。
const DEEP_REVIEW_WRAP_UP_RESERVE_RATIO = 0.4;
// 判定「已给出结论」的宽松特征：命中任一即认为有可解析输出，无需收尾。
const DEEP_REVIEW_VERDICT_PATTERN = /VERDICT|结论|判定/i;

export interface DeepReviewAgentLoopResult {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  turns: number;
  toolCalls?: ModelToolCall[];
}

function sumUsage(
  total: ModelUsage | undefined,
  delta: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!delta) return total;
  if (!total) return delta;
  const add = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(total.inputTokens, delta.inputTokens),
    outputTokens: add(total.outputTokens, delta.outputTokens),
    totalTokens: add(total.totalTokens, delta.totalTokens),
    cacheReadTokens: add(total.cacheReadTokens, delta.cacheReadTokens),
    cacheWriteTokens: add(total.cacheWriteTokens, delta.cacheWriteTokens),
    reasoningTokens: add(total.reasoningTokens, delta.reasoningTokens),
  } as ModelUsage;
}

export async function runDeepReviewAgentLoop(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    messages: ModelInputMessage[];
    model: Model;
    onProgress?: (progress: WorkspaceGenerateTextProgress) => void;
    /**
     * 外层（generateWorkspaceText）已解析的单轮选项：UI 按模型声明上限传入的
     * maxOutputTokens 在此。丢了它会退回只用绑定模型的默认选项——预算不足时
     * adapter 校验或 reasoning 吃光正文，深度审查直接失败。
     */
    requestOptions?: ModelRequest["options"];
    traceContext?: TraceContext;
    /**
     * 软 deadline（epoch ms）：调查轮在 `deadlineAt - 收尾预留` 处停止并提前进入
     * 禁用工具的收尾轮，保证「deadline 内要么有结论要么尽早失败」。缺席 = 无软
     * deadline，仅由外层 hard-abort 兜底（实测孤儿审查零结论烧满全程的教训）。
     */
    deadlineAt?: number;
  },
): Promise<DeepReviewAgentLoopResult> {
  // 只读白名单的工具契约：从本 runtime 的注册表取定义，白名单外（写工具、
  // Agent、MCP 等）根本不进 provider 请求的工具目录。
  const tools = runtime.registry
    .toContracts()
    .filter((contract) => DEEP_REVIEW_ALLOWED_TOOLS.has(contract.name));
  const executor = createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getWorkingDirectory: () => runtime.workingDirectory,
    getWorkspaceRoot: () => runtime.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // 全新 readFileState：深度审查的读上下文独立于主会话。
    readFileState: new Map(),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: input.traceContext,
  });

  let currentRound = 0;
  let lastText = "";
  let lastFinishReason = "unknown";
  let totalUsage: ModelUsage | undefined;
  // 已完成轮次的字符总量：逐轮 progress 是本轮累计，直接上报会让 UI 数字每轮回跳。
  let completedRoundsChars = 0;
  let roundStartChars = 0;
  let lastOutputChars = 0;
  // 调查截止：总预算扣除收尾预留。到达后调查循环软停止，立即进入收尾轮。
  const investigateDeadlineAt =
    input.deadlineAt === undefined
      ? undefined
      : input.deadlineAt -
        Math.round((input.deadlineAt - Date.now()) * DEEP_REVIEW_WRAP_UP_RESERVE_RATIO);
  let stoppedByDeadline = false;

  const loopResult = await runToolAgentLoop({
    abortSignal: input.abortSignal,
    executeTool: (toolCall, options) =>
      executor.execute(toolCall, {
        signal: options?.abortSignal,
        traceContext: input.traceContext,
      }),
    // 逐轮流式生成（与标准审查同一防静默手段）+ 进度透传（轮次/输出字符）。
    generate: async (model, request) => {
      const round = currentRound;
      roundStartChars = completedRoundsChars;
      const result = await streamModelTextResult(model, request, (progress) => {
        lastOutputChars = roundStartChars + progress.outputChars;
        input.onProgress?.({ outputChars: lastOutputChars, round });
      });
      lastText = result.text;
      lastFinishReason = result.finishReason;
      totalUsage = sumUsage(totalUsage, result.usage);
      // 偏移取本轮**最后上报的累计值**（含思考增量），不能用 result.text.length：
      // 思考型模型一轮的 reasoning 字符远多于可见正文，按正文长度设偏移会让
      // 下一轮首个进度值低于上一轮末尾，UI 数字回跳（本修复原想消除的问题）。
      // 本轮无任何增量时 lastOutputChars 仍等于 roundStartChars，偏移不变。
      completedRoundsChars = lastOutputChars;
      return { text: result.text, toolCalls: result.toolCalls };
    },
    maxTurns: DEEP_REVIEW_MAX_TURNS,
    messages: input.messages,
    model: input.model,
    onTurn: (event) => {
      currentRound = event.turn;
      if (event.phase === "tool" && event.toolName) {
        input.onProgress?.({
          outputChars: lastOutputChars,
          round: event.turn,
          toolName: event.toolName,
          ...(event.toolCall ? { toolTarget: describeDeepReviewToolTarget(event.toolCall) } : {}),
        });
      }
    },
    // 合并顺序与外层单轮语义一致：绑定模型的自带选项（推理档）为底，
    // 外层显式解析出的预算（maxOutputTokens）覆盖在上面。
    requestOptions: (model) => ({ ...model.options, ...input.requestOptions }),
    // tool-use 边界的只读硬闸：非白名单工具与写类 Bash 一律拒绝并回填错误，
    // 模型下一轮能看到拒绝原因。
    evaluateToolPolicy: (toolCall) => evaluateDeepReviewToolPolicy(toolCall, runtime),
    rootDir: runtime.workingDirectory,
    shouldStop: () => {
      if (investigateDeadlineAt !== undefined && Date.now() >= investigateDeadlineAt) {
        stoppedByDeadline = true;
        return true;
      }
      return false;
    },
    tools,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  });

  // 轮次用尽/时间触顶/结束时没有结论特征（典型：最后一轮只调工具没有正文）→ 收尾强制结论。
  if (!DEEP_REVIEW_VERDICT_PATTERN.test(lastText)) {
    const wrapUpMessages: ModelInputMessage[] = [
      ...loopResult.messages,
      {
        role: "user",
        content: stoppedByDeadline
          ? DEEP_REVIEW_DEADLINE_WRAP_UP_INSTRUCTION
          : DEEP_REVIEW_WRAP_UP_INSTRUCTION,
      },
    ];
    currentRound += 1;
    input.onProgress?.({ outputChars: lastOutputChars, round: currentRound });
    await runToolAgentLoop({
      abortSignal: input.abortSignal,
      executeTool: (toolCall, options) =>
        executor.execute(toolCall, {
          signal: options?.abortSignal,
          traceContext: input.traceContext,
        }),
      generate: async (model, request) => {
        const round = currentRound;
        roundStartChars = completedRoundsChars;
        const result = await streamModelTextResult(model, request, (progress) => {
          lastOutputChars = roundStartChars + progress.outputChars;
          input.onProgress?.({ outputChars: lastOutputChars, round });
        });
        lastText = result.text;
        lastFinishReason = result.finishReason;
        totalUsage = sumUsage(totalUsage, result.usage);
        completedRoundsChars = lastOutputChars;
        return { text: result.text, toolCalls: result.toolCalls };
      },
      // 收尾轮不给工具：模型只能产出正文结论。
      maxTurns: 1,
      messages: wrapUpMessages,
      model: input.model,
      requestOptions: (model) => ({ ...model.options, ...input.requestOptions }),
      evaluateToolPolicy: () => ({
        allowed: false,
        reason: "Deep review wrap-up: no tools available, output the conclusion directly.",
      }),
      rootDir: runtime.workingDirectory,
      tools: [],
      workingDirectory: runtime.workingDirectory,
      workspaceRoot: runtime.workspaceRoot,
    });
  }

  return {
    text: lastText,
    finishReason: lastFinishReason,
    // 循环至少跑一轮生成，totalUsage 理论必非空；零值兜底满足结果的非可选契约。
    usage: totalUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    turns: loopResult.turns,
  };
}

// 展示用目标长度上限：路径/命令可能极长，横幅只做线索展示。
const DEEP_REVIEW_TOOL_TARGET_MAX_CHARS = 120;

function stringField(input: unknown, ...keys: string[]): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 把工具调用压成一行展示目标：Read→文件路径，Grep/Glob→pattern（+目录），
 * Bash→命令原文。导出仅为单测。
 */
export function describeDeepReviewToolTarget(toolCall: ModelToolCall): string | undefined {
  const input = toolCall.input;
  let target: string | undefined;
  if (toolCall.name === "Read") {
    target = stringField(input, "file_path", "filePath", "path");
  } else if (toolCall.name === "Grep") {
    const pattern = stringField(input, "pattern");
    const path = stringField(input, "path", "glob");
    target = pattern ? (path ? `${pattern} (${path})` : pattern) : path;
  } else if (toolCall.name === "Glob") {
    target = stringField(input, "pattern", "path");
  } else if (toolCall.name === "Bash") {
    target = stringField(input, "command");
  }
  if (!target) return undefined;
  return target.length > DEEP_REVIEW_TOOL_TARGET_MAX_CHARS
    ? `${target.slice(0, DEEP_REVIEW_TOOL_TARGET_MAX_CHARS)}…`
    : target;
}

type DeepReviewToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

// ── 取证路径边界（v2：从「diff 文件白名单」放宽为「工作区只读」的硬边界）──
// prompt 层只约束行为（任务相关的源码/测试/配置/文档），真正的边界在 tool-use
// 策略层：Read/Grep/Glob 的目标路径经词法归一化后必须落在工作区内；Bash 只读命令
// 里出现的绝对路径同样不得逃出工作区（防 `cat /etc/passwd` 绕过 Read 的限制）。
// 词法检查不解析符号链接（executor 的 symlink 语义不变），是 best-effort 硬闸；
// 无法确认目标的 Bash 命令宁可拒绝，由模型改用 Read/Grep/Glob 取证。
//
// 已知的两类词法盲区（实测逃逸/误拒）必须显式处理，不能只靠 resolve：
// - `~` 与裸 `..`：前者在 Bash 里被真实展开到 HOME，后者无分隔符会被路径检查跳过；
//   两者都无法用词法包含判定，一律按「工作区外」拒绝（保守方向）。
// - MSYS/git-bash 盘符路径 `/c/Users/x`：win32 下 normalize 成 `\c\Users\x` 与
//   `C:\` 不同根，会把工作区内文件误判成逃逸 —— 先归一为 `C:\Users\x` 再判包含。

function isPathInsideRoot(candidate: string, root: string): boolean {
  // relative() 按平台语义统一处理分隔符；「.. 开头或仍是绝对路径」即逃逸。
  const rel = relative(normalize(root), normalize(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** MSYS/git-bash 盘符路径（/c/Users/x）归一为 win32 形式（C:\Users\x）后再判包含。 */
function normalizeMsysDrivePath(input: string): string {
  if (process.platform !== "win32") return input;
  const match = /^\/([A-Za-z])(\/|$)/.exec(input);
  if (!match) return input;
  return `${match[1]!.toUpperCase()}:\\${input.slice(2).replace(/\//g, "\\")}`;
}

/** HOME 相对（~ / ~/x）：Bash 会展开到工作区外，词法上无法确认，一律拒绝。 */
function isHomeRelativePath(token: string): boolean {
  return token === "~" || token.startsWith("~/") || token.startsWith("~\\");
}

/** 工具输入里的路径字段：相对路径相对工作目录解析，绝对路径必须落在工作区内。 */
function isAllowedEvidencePath(
  rawPath: string,
  workingDirectory: string,
  workspaceRoot: string,
): boolean {
  const trimmed = rawPath.trim();
  if (!trimmed) return true;
  // URL/URI（含 ://）不是文件路径，交给工具自身语义处理。
  if (trimmed.includes("://")) return true;
  if (isHomeRelativePath(trimmed)) return false;
  const candidate = normalizeMsysDrivePath(trimmed);
  const resolved = isAbsolute(candidate)
    ? normalize(candidate)
    : resolve(workingDirectory, normalize(candidate));
  return (
    isPathInsideRoot(resolved, workingDirectory) || isPathInsideRoot(resolved, workspaceRoot)
  );
}

function stringRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

/** Bash 命令的粗粒度路径扫描：任何疑似工作区外的路径都拒绝（保守方向）。 */
function bashEscapesWorkspace(command: string, workingDirectory: string, workspaceRoot: string): boolean {
  // shell 引号内的路径也按 token 切：deep review 的取证命令不需要精巧转义。
  const tokens = command.split(/\s+/);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, "");
    if (!token || token.startsWith("-")) continue;
    if (token.includes("://")) continue;
    // HOME 相对与裸父目录：Bash 展开后必然指向工作区外（`~`→HOME，`..`→父目录），
    // 且 `..` 无分隔符会被下面的路径检查跳过，必须在这里单独拦。
    if (isHomeRelativePath(token)) return true;
    if (token === ".." || token.startsWith("../") || token.startsWith("..\\")) return true;
    // 含路径分隔符或以盘符/根开头的 token 才按路径检查；纯文件名交给相对解析。
    const looksLikePath = token.includes("/") || token.includes("\\") || /^[A-Za-z]:/.test(token);
    if (!looksLikePath) continue;
    if (!isAllowedEvidencePath(token, workingDirectory, workspaceRoot)) {
      return true;
    }
  }
  return false;
}

function describeDeepReviewPathInput(toolCall: ModelToolCall): string | null {
  const input = stringRecord(toolCall.input);
  if (!input) return null;
  for (const key of ["file_path", "filePath", "path", "glob"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** 导出仅为单测；生产路径只经 runDeepReviewAgentLoop 的循环边界调用。 */
export function evaluateDeepReviewToolPolicy(
  toolCall: ModelToolCall,
  runtime: AgentRuntimeInternal,
): DeepReviewToolPolicyDecision {
  if (toolCall.name === "Read" || toolCall.name === "Grep" || toolCall.name === "Glob") {
    const rawPath = describeDeepReviewPathInput(toolCall);
    if (
      rawPath !== null &&
      !isAllowedEvidencePath(rawPath, runtime.workingDirectory, runtime.workspaceRoot)
    ) {
      return {
        allowed: false,
        reason: `Deep review is read-only and workspace-scoped: path "${rawPath.slice(0, 200)}" is outside the workspace. Only files inside the workspace can be read.`,
      };
    }
    return { allowed: true };
  }
  if (toolCall.name === "Bash") {
    const input = stringRecord(toolCall.input);
    const command = typeof input?.command === "string" ? input.command : undefined;
    if (
      typeof command === "string" &&
      isRuntimeReadOnlyBashCommand(command, {
        workingDirectory: runtime.workingDirectory,
        workspaceRoot: runtime.workspaceRoot,
      })
    ) {
      if (
        command &&
        bashEscapesWorkspace(command, runtime.workingDirectory, runtime.workspaceRoot)
      ) {
        return {
          allowed: false,
          reason:
            "Deep review is read-only and workspace-scoped: this command references paths outside the workspace. Use Read/Grep/Glob for workspace files instead.",
        };
      }
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        "Deep review is read-only: only read-only shell commands are allowed (ls, find, grep, cat, git log, git diff, git show, and similar). Write/exec commands are denied.",
    };
  }
  return {
    allowed: false,
    reason: `Deep review is read-only: tool ${toolCall.name} is not available. Only Read, Grep, Glob and read-only Bash are allowed.`,
  };
}
