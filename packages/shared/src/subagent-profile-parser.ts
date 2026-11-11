import { parseAgentFrontmatter, splitMarkdownFrontmatter } from "./subagent-profile-frontmatter.js";
import { parseSubagentMarkdownSelection } from "./subagent-markdown-selection.js";
import { findExternalAgentPreset } from "./externalAgentCatalog.js";
import type { AgentPermissionMode } from "./subagents-types.js";
import type {
  AgentProfile,
  AgentProfileSource,
  AgentProfileBackend,
  AgentMemoryScope,
  AgentProfileParseDiagnostic,
} from "./subagent-profile.js";

const VALID_COLORS = new Set<NonNullable<AgentProfile["color"]>>([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

const VALID_PERMISSION_MODES = new Set<AgentPermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

const VALID_MEMORY_SCOPES = new Set<AgentMemoryScope>(["user", "project", "local"]);

export function parseAgentProfileFromMarkdown(input: {
  content: string;
  path?: string;
  source: AgentProfileSource;
}): { diagnostic?: AgentProfileParseDiagnostic; profile?: AgentProfile } {
  const parsed = splitMarkdownFrontmatter(input.content);
  if (!parsed.frontmatter) {
    return {
      diagnostic: {
        code: "agent_missing_frontmatter",
        message: `Agent Markdown must include frontmatter: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  const { mcpServers, values: frontmatter } = parseAgentFrontmatter(parsed.frontmatter);
  const name = scalarString(frontmatter.name);
  const description = scalarString(frontmatter.description)?.replace(/\\n/gu, "\n");
  if (!name) {
    return missingRequiredDiagnostic("name", input.path);
  }
  if (!description) {
    return missingRequiredDiagnostic("description", input.path);
  }

  // model 字段的含义随 backend 走：native 用清晰的 provider/model 选择格式
  // （`providerId/modelId`），external 则是原样透传给 CLI 的 `--model` 名（如
  // `DeepSeek-V4-Pro`）。先定 backend 再解析，避免把 CLI 模型名当成坏的选择格式
  // 静默丢弃（那会让用户以为模型没生效，却看不到任何报错）。
  const isExternalBackend = scalarString(frontmatter.backend) === "external";
  const modelSelection = isExternalBackend
    ? undefined
    : parseSubagentMarkdownSelection(frontmatter);
  const color = normalizeColor(scalarString(frontmatter.color));
  const parsedPermissionMode = normalizePermissionMode(scalarString(frontmatter.permissionMode));
  // 修复原因：项目级 subagent markdown 属于仓库输入，不能通过 frontmatter 把
  // child runtime 提升到 bypass/yolo；项目级声明在此剥离。插件 profile 也以 source: "user" 解析，
  // 这里不剥离；插件 loader 会标记 permissionModeRestrictOnly，派生子会话时 core 只取比父会话更严格的模式。
  const permissionMode = input.source === "project" ? undefined : parsedPermissionMode;
  const maxTurns = normalizePositiveInteger(frontmatter.maxTurns);
  const memory = parseAgentMemoryScope(frontmatter.memory);
  const memoryDiagnostic =
    frontmatter.memory !== undefined && memory === undefined
      ? {
          code: "agent_invalid_memory_scope",
          message: `Agent frontmatter memory must be user, project, or local: ${input.path ?? "<inline>"}`,
          path: input.path,
        }
      : undefined;
  if (mcpServers === null) {
    return {
      diagnostic: {
        code: "agent_invalid_mcp_servers",
        message: `Agent frontmatter mcpServers must be a list of parent server names: ${input.path ?? "<inline>"}`,
        path: input.path,
      },
    };
  }

  // 外部后端：backend/preset 必须成对且指向一个可绑定（full adaptation）的预设。
  // 校验放在这里（而不是等 launch 时）是因为 profile 是用户写的资产：
  // 写错要在他保存的那一刻就报出来，而不是等第一次派活静默失败。
  const external = parseExternalBackend({
    backendValue: frontmatter.backend,
    presetValue: frontmatter.preset,
    modelValue: frontmatter.model,
    effortValue: frontmatter.effort,
    contextWindowValue: frontmatter.contextWindow,
    values: frontmatter,
    path: input.path,
  });
  if (external.diagnostic) {
    return { diagnostic: external.diagnostic };
  }

  return {
    // 软诊断（外部 profile 上无原生字段）：保留 profile，只提示"写了但不生效"。
    // 硬诊断（backend/preset 非法）在上一行已经阻断。
    ...((external.warning ?? memoryDiagnostic)
      ? { diagnostic: (external.warning ?? memoryDiagnostic)! }
      : {}),
    profile: {
      name,
      description,
      source: input.source,
      systemPrompt: parsed.body.trim(),
      ...(input.path ? { path: input.path } : {}),
      ...(modelSelection ? { modelSelection } : {}),
      ...(color ? { color } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(memory ? { memory } : {}),
      ...optionalList("tools", frontmatter.tools),
      ...optionalList("disallowedTools", frontmatter.disallowedTools),
      ...optionalList("skills", frontmatter.skills),
      ...optionalBoolean("background", frontmatter.background),
      ...optionalBoolean("injectAgentsMd", frontmatter.injectAgentsMd),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...external.fields,
    },
  };
}

/**
 * 解析 backend/preset 及其外部执行覆盖项。
 *
 * 三个不变量的取舍：
 * 1. **backend 缺省 = native**：存量 profile 一个字段都不用加；只有显式写了
 *    `backend: external` 才走外部路径。
 * 2. **external 必须有 preset**：没有 preset 的 external profile 无法执行，
 *    与其让它在 launch 时抛"未知预设"，不如在解析期报 `agent_missing_required_frontmatter`。
 * 3. **preset 必须是 full adaptation**：半适配预设（claude-code/codex）自身都不能
 *    正常完成一次委派，让主 agent 通过 profile 调用它只会得到含糊的失败。
 *    这条与绑定弹窗的 `EXTERNAL_AGENT_BINDABLE_PRESETS` 同口径。
 */
function parseExternalBackend(input: {
  backendValue: unknown;
  presetValue: unknown;
  modelValue: unknown;
  effortValue: unknown;
  contextWindowValue: unknown;
  /** 原始 frontmatter（用于诊断"写了但不生效"的原生专属字段）。 */
  values: Record<string, unknown>;
  path: string | undefined;
}): {
  diagnostic?: AgentProfileParseDiagnostic;
  /** 软诊断：profile 仍然有效，只是某些字段不生效。 */
  warning?: AgentProfileParseDiagnostic;
  fields: Partial<AgentProfile>;
} {
  const location = input.path ?? "<inline>";
  const rawBackend = scalarString(input.backendValue);
  if (rawBackend !== undefined && rawBackend !== "native" && rawBackend !== "external") {
    return {
      fields: {},
      diagnostic: {
        code: "agent_invalid_backend",
        message: `Agent frontmatter backend must be native or external: ${location}`,
        path: input.path,
      },
    };
  }
  const backend = rawBackend as AgentProfileBackend | undefined;
  const preset = scalarString(input.presetValue);

  if (backend !== "external") {
    // native profile 上写了 preset 是自相矛盾的配置：静默忽略会让用户以为它生效了。
    if (preset !== undefined) {
      return {
        fields: {},
        diagnostic: {
          code: "agent_preset_requires_external_backend",
          message: `Agent frontmatter preset requires backend: external: ${location}`,
          path: input.path,
        },
      };
    }
    return { fields: {} };
  }

  if (preset === undefined) {
    return {
      fields: {},
      diagnostic: {
        code: "agent_missing_required_frontmatter",
        message: `Agent frontmatter must include preset when backend is external: ${location}`,
        path: input.path,
      },
    };
  }

  const found = findExternalAgentPreset(preset);
  if (!found) {
    return {
      fields: {},
      diagnostic: {
        code: "agent_unknown_external_preset",
        message: `Agent frontmatter preset is not a known external agent preset: ${preset} (${location})`,
        path: input.path,
      },
    };
  }
  if (found.adaptation !== "full") {
    return {
      fields: {},
      diagnostic: {
        code: "agent_external_preset_not_bindable",
        message: `Agent frontmatter preset is only partially adapted and cannot run: ${preset} (${location})`,
        path: input.path,
      },
    };
  }

  const contextWindow = normalizePositiveInteger(input.contextWindowValue);
  if (input.contextWindowValue !== undefined && contextWindow === undefined) {
    return {
      fields: {},
      diagnostic: {
        code: "agent_invalid_context_window",
        message: `Agent frontmatter contextWindow must be a positive integer (tokens): ${location}`,
        path: input.path,
      },
    };
  }

  // native 专属字段在外部 profile 上**不生效**（这些限制作用于 ZCode 自己的子
  // runtime，管不到另一个进程里的 CLI）。不阻断加载——用户可能只是留了旧字段——
  // 但要给出诊断，否则他会以为 tools: Read 真的限制了外部 agent 的能力。
  const ignored = NATIVE_ONLY_FIELDS.filter((field) => input.values[field] !== undefined);
  const ignoredDiagnostic: AgentProfileParseDiagnostic | undefined =
    ignored.length > 0
      ? {
          code: "agent_external_ignores_native_fields",
          message: `Agent frontmatter fields have no effect when backend is external: ${ignored.join(", ")} (${location})`,
          path: input.path,
        }
      : undefined;

  return {
    fields: {
      backend: "external",
      preset,
      ...(scalarString(input.modelValue) ? { model: scalarString(input.modelValue)! } : {}),
      ...(scalarString(input.effortValue) ? { effort: scalarString(input.effortValue)! } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    },
    ...(ignoredDiagnostic ? { warning: ignoredDiagnostic } : {}),
  };
}

/**
 * 只对原生子运行时生效、对外部 CLI 无效的 frontmatter 字段。
 *
 * 保留清单而不是逐个内联判断：将来加新的原生字段时，这里漏掉一条就会变成
 * "用户写了但静默无效"，而那正是这类适配层最容易积累的技术债。
 */
const NATIVE_ONLY_FIELDS = [
  "tools",
  "disallowedTools",
  "skills",
  "mcpServers",
  "maxTurns",
  "memory",
  "injectAgentsMd",
] as const;

function parseAgentMemoryScope(value: unknown): AgentMemoryScope | undefined {
  return typeof value === "string" && VALID_MEMORY_SCOPES.has(value as AgentMemoryScope)
    ? (value as AgentMemoryScope)
    : undefined;
}

function missingRequiredDiagnostic(
  field: string,
  path: string | undefined,
): { diagnostic: AgentProfileParseDiagnostic } {
  return {
    diagnostic: {
      code: "agent_missing_required_frontmatter",
      message: `Agent frontmatter must include ${field}: ${path ?? "<inline>"}`,
      path,
    },
  };
}

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return normalizeToolNames(normalizeStringList(value));
  }
  if (typeof value !== "string") return undefined;
  const result: string[] = [];
  let current = "";
  let parenDepth = 0;
  for (const char of value) {
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (parenDepth === 0 && (char === "," || /\s/u.test(char))) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return normalizeToolNames(result);
}

function optionalList(
  key: "disallowedTools" | "skills" | "tools",
  value: unknown,
): Partial<AgentProfile> {
  const list = key === "skills" ? normalizeStringList(value) : parseToolList(value);
  if (list && list.length > 0) return { [key]: list };
  if (key === "tools" && Array.isArray(value)) {
    return { tools: [] };
  }
  return {};
}

function optionalBoolean(
  key: "background" | "injectAgentsMd",
  value: unknown,
): Partial<AgentProfile> {
  if (typeof value === "boolean") return { [key]: value };
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return { [key]: true };
    if (value.toLowerCase() === "false") return { [key]: false };
  }
  return {};
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const list = value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
    return list.length > 0 ? list : undefined;
  }
  if (typeof value !== "string") return undefined;
  const list = value
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function scalarString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeColor(value: string | undefined): AgentProfile["color"] | undefined {
  if (!value) return undefined;
  return VALID_COLORS.has(value as NonNullable<AgentProfile["color"]>)
    ? (value as NonNullable<AgentProfile["color"]>)
    : undefined;
}

function normalizePermissionMode(value: string | undefined): AgentPermissionMode | undefined {
  if (!value) return undefined;
  return VALID_PERMISSION_MODES.has(value as AgentPermissionMode)
    ? (value as AgentPermissionMode)
    : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeToolNames(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const names = values.map(toolNameFromSpec).filter((item) => item.length > 0);
  return names.length > 0 ? names : undefined;
}

function toolNameFromSpec(value: string): string {
  const trimmed = value.trim();
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex < 0) return trimmed;
  return trimmed.slice(0, parenIndex).trim();
}
