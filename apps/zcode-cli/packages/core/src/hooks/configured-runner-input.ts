import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceHookTimeoutMs } from "@zcode/shared/workspace-hook-discovery";
import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type ExecutionPort,
  type HookConfig,
  type HookInput,
  type HookPluginContext,
} from "@zcode/contracts";

/**
 * 宿主路径翻译器：会话执行环境与宿主不同平台时（如 Linux 借用端口）由执行端口提供。
 * 返回 null 表示不可映射——调用方必须显式失败（spec：不可映射能力明确标为不支持）。
 */
export type HookPathTranslate = (path: string) => Promise<string | null>;

/** hook 里表示宿主路径的变量名（值同源，报错时按变量名给出可定位信息）。 */
const HOOK_PLUGIN_ROOT_VARIABLE = "CLAUDE_PLUGIN_ROOT";
const HOOK_PLUGIN_DATA_VARIABLE = "CLAUDE_PLUGIN_DATA";
const HOOK_PROJECT_DIR_VARIABLE = "CLAUDE_PROJECT_DIR";

/** 取执行端口的宿主路径翻译能力；端口未实现即「执行环境即宿主」，按原值使用。 */
export function resolveHookPathTranslate(
  executionPort: ExecutionPort | undefined,
): HookPathTranslate | undefined {
  const translate = executionPort?.translateHostPath;
  if (typeof translate !== "function") {
    return undefined;
  }
  return (path: string) => translate.call(executionPort, path);
}

export interface HookPathEnvironment {
  /** 已翻译到执行环境的插件上下文（rootPath/dataPath 可直接交给执行环境）。 */
  plugin: HookPluginContext | undefined;
  /**
   * cwd 已翻译到执行环境的 hook 输入。展开、env 覆盖与 stdin 都用它，
   * 避免 `input.cwd || workingDirectory` 把宿主 cwd 又捡回来。
   */
  input: HookInput;
}

/**
 * 把 hook 会用到的宿主路径（插件根/数据目录、项目目录）翻译成执行环境路径。
 *
 * 现场缺陷：插件 hook 命令形如 `python3 "${CLAUDE_PLUGIN_ROOT}/hooks/x.py"`，
 * 变量展开成 Windows 路径后原样交给 Linux shell——`C:\...` 被当相对路径拼到 cwd，
 * 得到 `/mnt/c/.../agent/C:\...`，python3 打不开文件退非零码，hook 被当成拦阻（fail-closed），
 * 于是 Linux 会话里每条 prompt 都被这个「从不 block」的 hook 拦下。
 */
export async function resolveHookPathEnvironment(params: {
  plugin: HookPluginContext | undefined;
  input: HookInput;
  workingDirectory: string;
  translate: HookPathTranslate | undefined;
}): Promise<HookPathEnvironment> {
  const { input, translate } = params;
  if (!translate) {
    return { plugin: params.plugin, input };
  }
  const translateValue = async (value: string, variable: string): Promise<string> => {
    // 已是执行环境绝对路径（调用方已映射过）或空值时不做二次翻译。
    if (!value || value.startsWith("/")) {
      return value;
    }
    const mapped = await translate(value);
    if (mapped === null) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        `Hook variable ${variable} points to a host path that cannot be used in this execution environment: ${value}`,
        {
          context: {
            hookEventName: input.hookEventName,
            path: value,
            variable,
          },
          recoverable: true,
        },
      );
    }
    return mapped;
  };

  const projectDirectory = input.cwd || params.workingDirectory;
  const translatedProjectDirectory = await translateValue(
    projectDirectory,
    HOOK_PROJECT_DIR_VARIABLE,
  );
  const plugin = params.plugin;
  const translatedPlugin = plugin
    ? {
        ...plugin,
        rootPath: await translateValue(plugin.rootPath, HOOK_PLUGIN_ROOT_VARIABLE),
        dataPath: await translateValue(plugin.dataPath, HOOK_PLUGIN_DATA_VARIABLE),
      }
    : undefined;
  return {
    plugin: translatedPlugin,
    input: translatedProjectDirectory ? { ...input, cwd: translatedProjectDirectory } : input,
  };
}

export async function createCompatibleHookStdin(
  input: HookInput,
  options: { translate?: HookPathTranslate } = {},
): Promise<{
  cleanup: () => Promise<void>;
  value: string;
}> {
  const compatible: Record<string, unknown> = {
    ...input,
    agent_type: input.agentName,
    hook_event_name: input.hookEventName,
    permission_mode: input.mode,
    session_id: input.sessionId,
  };
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-hook-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  await writeFile(transcriptPath, formatTranscript(input), "utf8");
  // transcript 落在宿主临时目录；Linux 会话下必须给出执行环境可读的等价路径。
  const exposedTranscriptPath =
    options.translate && !transcriptPath.startsWith("/")
      ? ((await options.translate(transcriptPath)) ?? transcriptPath)
      : transcriptPath;
  compatible.transcript_path = exposedTranscriptPath;
  compatible.transcriptPath = exposedTranscriptPath;

  if ("toolName" in input) {
    // 这里只补无损 alias，继续保留 ZCode camelCase 字段作为内部主契约。
    compatible.tool_name = input.toolName;
    compatible.tool_input = input.toolInput;
    compatible.tool_use_id = input.toolCallId;
  }

  switch (input.hookEventName) {
    case HookEventName.PermissionRequest:
      compatible.permission_suggestions = input.permissionSuggestions;
      break;
    case HookEventName.PostToolUse:
      compatible.tool_response = input.toolResponse;
      break;
    case HookEventName.PostToolUseFailure:
      compatible.error_details = input.error;
      compatible.error = input.error.message;
      compatible.is_interrupt = input.isInterrupt;
      break;
    case HookEventName.Stop:
      compatible.last_assistant_message = input.responseText ?? input.responsePreview;
      compatible.stop_hook_active = input.stopHookActive;
      break;
    case HookEventName.SessionStart:
    case HookEventName.UserPromptSubmit:
    case HookEventName.PreToolUse:
      break;
  }

  return {
    value: `${JSON.stringify(compatible)}\n`,
    cleanup: async () => {
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}

export function resolveHookTimeoutMs(hook: HookConfig, defaultTimeoutMs: number): number {
  return resolveWorkspaceHookTimeoutMs(hook, defaultTimeoutMs);
}

export function createPluginEnvOverlay(
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
) {
  const set: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  if (!plugin) return { set };
  return {
    set: {
      ...set,
      CLAUDE_PLUGIN_DATA: plugin.dataPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
      ZCODE_PLUGIN_DATA: plugin.dataPath,
      ZCODE_PLUGIN_ID: plugin.id,
      ZCODE_PLUGIN_NAME: plugin.name,
      ZCODE_PLUGIN_ROOT: plugin.rootPath,
    },
  };
}

export function expandPluginVariables(
  value: string,
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
): string {
  const replacements: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  if (plugin) {
    replacements.CLAUDE_PLUGIN_DATA = plugin.dataPath;
    replacements.CLAUDE_PLUGIN_ROOT = plugin.rootPath;
    replacements.ZCODE_PLUGIN_DATA = plugin.dataPath;
    replacements.ZCODE_PLUGIN_ROOT = plugin.rootPath;
  }
  return value.replace(
    /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu,
    (_match, key: string) => {
      if (key === "CLAUDE_SKILL_DIR" || key === "ZCODE_SKILL_DIR") {
        // hook 运行时没有“当前 skill”语义，不能把该变量交给 shell 展开为空字符串。
        // 这里提前报错，插件诊断/日志能看到明确的上下文缺失原因。
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          `Hook variable requires a skill context: ${key}`,
          {
            context: {
              hookEventName: input.hookEventName,
              variable: key,
            },
            recoverable: true,
          },
        );
      }
      return replacements[key] ?? _match;
    },
  );
}

function formatTranscript(input: HookInput): string {
  if (input.hookEventName === HookEventName.Stop) {
    return formatMessageLine("assistant", input.responseText ?? input.responsePreview);
  }
  if (input.hookEventName === HookEventName.UserPromptSubmit) {
    return formatMessageLine("user", input.prompt);
  }
  return "";
}

function formatMessageLine(role: "assistant" | "user", text: string): string {
  return `${JSON.stringify({
    message: {
      content: [{ text, type: "text" }],
      role,
    },
  })}\n`;
}
