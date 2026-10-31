import { isAbsolute } from "node:path";

import type {
  ModelInputMessage,
  ModelMessageContent,
  Model,
  ModelReasoningContentBlock,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@zcode/contracts";

import {
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  type RuntimeMessageEntry,
} from "../agent/message-history.js";
import {
  isErrorForToolResult,
  modelContentForToolResult,
  toolBatchModelEntries,
} from "../runtime/helpers/tool-result.js";
import { projectMessagesForModelMediaPolicy } from "../runtime/helpers/media-budget.js";
import {
  analyzeBashCommand,
  isBashCommandPermissionSafe,
} from "../tool/handlers/bash-command-parser.js";
import { isRuntimeReadOnlyBashCommand } from "../tool/handlers/bash-semantics.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import { resolveContainedMemoryFilePath, resolveSafeMemoryFilePath } from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";

export type MemoryAgentModelRequest = ModelRequest;

/** 渲染器给出的一轮请求：消息、工具目录与 ToolSearch 开关。 */
export interface MemoryAgentRenderedRequest {
  messages: ModelInputMessage[];
  tools: ModelToolContract[];
  toolSearchEnabled: boolean;
}

export interface MemoryAgentLoopResult {
  entries: RuntimeMessageEntry[];
  turns: number;
}

/** 通用骨架的结果（深度审查等 message 视图调用方）；与 entries 视图互不混用。 */
export interface ToolAgentLoopResult {
  messages: ModelInputMessage[];
  turns: number;
}

export interface MemoryAgentToolPolicyInput {
  rootDir: string;
  toolCall: ModelToolCall;
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}

export type MemoryAgentToolPolicyDecision = { allowed: true } | { allowed: false; reason: string };

const MEMORY_AGENT_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob"]);
const MEMORY_AGENT_MISSING_RESULT = "Tool call returned no result";

/**
 * Memory Agent（Extraction、Dream）的循环。与 Main 共用单步内核，不另写"工具结果 → 下一次请求"：
 * 每轮用 Main 的渲染器从 entries 生成请求；通过 Memory 策略的 call 按 Main 的调度执行；
 * 一批结果用 Main 结算的同一个函数变成 entries（tool result + 批次附件）。见 memory/README.md。
 */
export async function runToolAgentLoop(input: {
  abortSignal?: AbortSignal;
  executeTool: (
    toolCall: ExecutableToolCall,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult>;
  /** 每轮模型请求的构造选项（推理档/输出预算）；缺席用辅助档（原 Memory 行为）。 */
  requestOptions?: (model: Model) => ModelRequest["options"];
  /** 每轮生成函数：默认一次性 generateText；流式调用方传 streamModelTextResult 包装。 */
  generate?: (
    model: Model,
    request: ModelRequest,
  ) => Promise<{
    text: string;
    reasoning?: readonly ModelReasoningContentBlock[];
    toolCalls?: ModelToolCall[];
  }>;
  /** 逐轮生成与工具执行的过程回调（深度审查的进度推送挂点）。 */
  onTurn?: (event: {
    turn: number;
    phase: "generate" | "tool";
    toolName?: string;
    /** 工具阶段携带原始调用（含 input），供调用方提取展示目标（路径/命令）。 */
    toolCall?: ModelToolCall;
  }) => void;
  maxTurns: number;
  request: {
    messages: readonly ModelInputMessage[];
    tools: readonly ModelToolContract[];
    toolSearchEnabled: boolean;
  };
  model: Model;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
  /** tool-use 边界策略；拒绝理由会作为错误工具消息回填进下一轮请求。 */
  evaluateToolPolicy: (toolCall: ModelToolCall) => MemoryAgentToolPolicyDecision;
  /** 每轮开始前的软停止判定：返回 true 时正常结束调查循环（区别于 abort 的抛错）。 */
  shouldStop?: () => boolean;
}): Promise<ToolAgentLoopResult> {
  const messages = input.request.messages.map(cloneModelMessage);
  let turns = 0;

  for (; turns < input.maxTurns; turns += 1) {
    input.abortSignal?.throwIfAborted();
    if (input.shouldStop?.()) {
      break;
    }
    // 只在 Memory 初始快照投影会漏掉 Read 等工具后续产生的媒体；每一次
    // provider 请求都必须在 request-local 副本上执行同一套 capability + budget 策略。
    const mediaProjection = projectMessagesForModelMediaPolicy(
      messages.map(cloneModelMessage),
      input.model.properties.inputFormat,
    );
    const request: ModelRequest = {
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: input.requestOptions
        ? input.requestOptions(input.model)
        : auxiliaryModelOptions(input.model),
      // Memory agent 的 provider request 必须保留 Main 的真实工具目录；执行权限只在 tool-use 边界收窄。
      tools: input.request.tools as ModelToolContract[],
      toolSearchEnabled: input.request.toolSearchEnabled,
    };
    input.onTurn?.({ turn: turns + 1, phase: "generate" });
    const response = await (input.generate
      ? input.generate(input.model, request)
      : input.model.generateText(request));
    input.abortSignal?.throwIfAborted();

    const toolCalls = response.toolCalls ?? [];
    messages.push(createAssistantMessage(response.text, response.reasoning, toolCalls));
    if (toolCalls.length === 0) {
      turns += 1;
      break;
    }

    const toolMessages = await Promise.all(
      toolCalls.map(async (toolCall): Promise<ModelInputMessage> => {
        input.onTurn?.({ turn: turns + 1, phase: "tool", toolName: toolCall.name, toolCall });
        const decision = input.evaluateToolPolicy(toolCall);
        if (!decision.allowed) {
          return {
            content: decision.reason,
            isError: true,
            role: "tool",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          };
        }

        const result = await input.executeTool(
          { id: toolCall.id, input: toolCall.input, name: toolCall.name },
          { abortSignal: input.abortSignal },
        );
        return {
          content: modelContentForToolResult(result),
          isError: isErrorForToolResult(result),
          role: "tool",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        };
      }),
    );
    messages.push(...toolMessages);
  }

  return { messages, turns };
}

export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  /** 初始 entries：Main 的 provider entries 加 prompt。 */
  entries: readonly RuntimeMessageEntry[];
  /** Main 的渲染器：每轮从全部 entries 生成请求。 */
  renderRequest: (entries: readonly RuntimeMessageEntry[]) => MemoryAgentRenderedRequest;
  /** Main 的调度与执行；只收到通过 Memory 策略的 call。 */
  executeToolCalls: (
    toolCalls: ExecutableToolCall[],
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult[]>;
  /** 结算读取工具声明的批次提示。 */
  registry: Pick<ToolRegistry, "get">;
  maxTurns: number;
  model: Model;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<MemoryAgentLoopResult> {
  const entries = [...input.entries];
  let turns = 0;

  for (; turns < input.maxTurns; turns += 1) {
    input.abortSignal?.throwIfAborted();
    const rendered = input.renderRequest(entries);
    // 只在 Memory 初始快照投影会漏掉 Read 等工具后续产生的媒体；每一次
    // provider 请求都必须执行同一套 capability + budget 策略。
    const mediaProjection = projectMessagesForModelMediaPolicy(
      rendered.messages,
      input.model.properties.inputFormat,
    );
    const request: ModelRequest = {
      abortSignal: input.abortSignal,
      messages: mediaProjection.messages,
      options: auxiliaryModelOptions(input.model),
      // Memory agent 的 provider request 必须保留 Main 的真实工具目录；执行权限只在 tool-use 边界收窄。
      tools: rendered.tools,
      toolSearchEnabled: rendered.toolSearchEnabled,
    };
    const response = await input.model.generateText(request);
    input.abortSignal?.throwIfAborted();

    const toolCalls = response.toolCalls ?? [];
    entries.push(createRuntimeAssistantEntry(response.text, toolCalls, response.reasoning));
    if (toolCalls.length === 0) {
      turns += 1;
      break;
    }

    const deniedReasons = new Map<string, string>();
    const allowedCalls: ExecutableToolCall[] = [];
    for (const toolCall of toolCalls) {
      const decision = evaluateMemoryAgentToolPolicy({
        rootDir: input.rootDir,
        toolCall,
        tools: rendered.tools,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      });
      if (decision.allowed) {
        allowedCalls.push({ id: toolCall.id, input: toolCall.input, name: toolCall.name });
      } else {
        deniedReasons.set(toolCall.id, decision.reason);
      }
    }
    const results =
      allowedCalls.length > 0
        ? await input.executeToolCalls(allowedCalls, { abortSignal: input.abortSignal })
        : [];
    const batch = toolBatchModelEntries(results, { registry: input.registry });
    const executedById = new Map(
      batch.toolResults.map((entry) => [entry.message.toolCallId, entry] as const),
    );
    // tool result 按 call 的声明顺序；被拒绝的 call 不进入调度，原位写拒绝结果。
    // 每个 tool_use 都要有 tool_result，否则下一次请求被 provider 拒绝；执行方没给结果时补错误结果。
    for (const toolCall of toolCalls) {
      const deniedReason = deniedReasons.get(toolCall.id);
      entries.push(
        deniedReason === undefined
          ? (executedById.get(toolCall.id) ??
              createRuntimeToolResultEntry(
                toolCall.id,
                toolCall.name,
                MEMORY_AGENT_MISSING_RESULT,
                true,
              ))
          : createRuntimeToolResultEntry(toolCall.id, toolCall.name, deniedReason, true),
      );
    }
    entries.push(...batch.attachments);
  }

  return { entries, turns };
}

export function evaluateMemoryAgentToolPolicy(
  input: MemoryAgentToolPolicyInput,
): MemoryAgentToolPolicyDecision {
  const contract = input.tools.find((tool) => tool.name === input.toolCall.name);
  // catalog miss 被合并进 Memory 权限拒绝会让未注册工具没有先走
  // No such tool 错误处理。此分支只闭合原 call id，不进入工具执行面。
  if (!contract) return denyUnavailableMemoryAgentTool(input.toolCall.name);

  if (
    input.toolCall.name === "Agent" ||
    input.toolCall.name.startsWith("mcp__") ||
    contract.sideEffectScope === "network"
  )
    return denyMemoryAgentTool(input.rootDir);

  if (input.toolCall.name === "Write" || input.toolCall.name === "Edit") {
    return isContainedMarkdownMutation(input)
      ? { allowed: true }
      : denyMemoryAgentTool(input.rootDir);
  }

  if (input.toolCall.name === "Bash") {
    const command = stringProperty(input.toolCall.input, "command");
    // Memory Agent 直接复用既有只读分类器，避免在此处二次收窄安全 env、redirect 和后台执行。
    if (
      command &&
      (isRuntimeReadOnlyBashCommand(command, {
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) ||
        isContainedMarkdownBashRemoval(command, input))
    ) {
      return { allowed: true };
    }
    return denyMemoryAgentBash(input.rootDir);
  }

  if (MEMORY_AGENT_READ_ONLY_TOOLS.has(input.toolCall.name)) {
    return { allowed: true };
  }

  return denyMemoryAgentTool(input.rootDir);
}

function isContainedMarkdownMutation(input: MemoryAgentToolPolicyInput): boolean {
  const filePath = stringProperty(input.toolCall.input, "file_path");
  if (!filePath?.endsWith(".md")) return false;
  try {
    return (
      resolveSafeMemoryFilePath({
        filePath,
        rootDir: input.rootDir,
        workingDirectory: input.workingDirectory,
        workspaceRoot: input.workspaceRoot,
      }) !== undefined
    );
  } catch {
    return false;
  }
}

function isContainedMarkdownBashRemoval(
  command: string,
  input: MemoryAgentToolPolicyInput,
): boolean {
  const analysis = analyzeBashCommand(command);
  if (!isBashCommandPermissionSafe(analysis) || analysis.commands.length !== 1) return false;
  const invocation = analysis.commands[0];
  if (!invocation || invocation.argv[0] !== "rm") return false;
  if (invocation.redirects.length > 0 || invocation.envAssignments.length > 0) return false;

  let afterOptions = false;
  let pathCount = 0;
  for (const argument of invocation.argv.slice(1)) {
    if (!afterOptions) {
      if (argument === "--") {
        afterOptions = true;
        continue;
      }
      if (argument.startsWith("-")) {
        if (argument === "--recursive" || /^-[a-zA-Z]*[rR]/u.test(argument)) return false;
        continue;
      }
    }
    if (/[*?[]/u.test(argument)) return false;
    if (!isAbsolute(argument) || !argument.endsWith(".md")) return false;
    if (resolveContainedPath(argument, input) === undefined) return false;
    pathCount += 1;
  }
  return pathCount > 0;
}

function resolveContainedPath(
  filePath: string,
  input: Pick<MemoryAgentToolPolicyInput, "rootDir" | "workingDirectory" | "workspaceRoot">,
): string | undefined {
  try {
    return resolveContainedMemoryFilePath({
      filePath,
      rootDir: input.rootDir,
      workingDirectory: input.workingDirectory,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return undefined;
  }
}

function createAssistantMessage(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
  toolCalls: readonly ModelToolCall[],
): ModelInputMessage {
  return {
    content: assistantContent(text, reasoning),
    role: "assistant",
    toolCalls: toolCalls.map((call) => ({ ...call })),
  };
}

function assistantContent(
  text: string,
  reasoning: readonly ModelReasoningContentBlock[] | undefined,
): ModelMessageContent {
  if (!reasoning?.length) return text;
  return [
    ...reasoning.map((block) => ({
      ...block,
      providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
    })),
    ...(text ? [{ text, type: "text" as const }] : []),
  ];
}

function cloneModelMessage(message: ModelInputMessage): ModelInputMessage {
  return {
    ...message,
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
    toolCalls: message.toolCalls?.map((call) => ({ ...call })),
  };
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

// 拒绝结果会进入下一轮 provider request，需按基线区分 Bash 与其他工具的固定文案。
function denyMemoryAgentBash(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `Only read-only shell commands and rm with all paths inside ${rootDir} are permitted in this context (ls, find, grep, cat, stat, wc, head, tail, and similar)`,
  };
}

function denyMemoryAgentTool(rootDir: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `only Read, Grep, Glob, read-only Bash, and Edit/Write within ${rootDir} are allowed`,
  };
}

function denyUnavailableMemoryAgentTool(toolName: string): MemoryAgentToolPolicyDecision {
  return {
    allowed: false,
    reason: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  };
}
