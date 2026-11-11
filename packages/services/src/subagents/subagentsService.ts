/* eslint-disable max-lines */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentStateId,
  createPluginAgentStateId,
  findExternalAgentPreset,
  isChannelReadyPreset,
  parsePluginSubagentModelSelectionOverrides,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  modelSelectionSchema,
  type SubagentRuntimeConfig,
  type AgentCreateParams,
  type AgentDeleteParams,
  type AgentDiagnostic,
  type AgentScope,
  type AgentSummary,
  type AgentUpdateParams,
  type AgentsCapability,
  type AgentsListResult,
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelOverrideParams,
  type PluginSubagentModelSelectionOverrides,
  type SubAgentConfig,
  type SubagentsListMode,
  type ZCodeProvider,
  type ExternalAgentPresetStatus,
  type BuiltInExecutionChannelOverrides,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "./subagentModelSelection.js";
import { serializeSubagentMarkdown, parseSubagentMarkdown } from "./subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  resolveZCodeStorageRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";
import type { ISubagentsService } from "./subagents.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
  scanOfficialPluginCacheRoots,
} from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

import { createSubagentRuntimeConfigCache } from "./subagentRuntimeConfig.js";

const subagentLogger = createServiceLogger("subagents");

interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  /** 内置身份执行渠道覆盖（S7）；读取时即做渠道候选收敛，未达标 key 丢弃。 */
  builtInExecutionChannel: BuiltInExecutionChannelOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

interface InstalledPluginsStateFile {
  plugins?: unknown;
}

interface PluginConfigSummary {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
}

interface InstalledPluginRecord {
  id: string;
  installPath: string;
  name: string;
  scope?: "user" | "workspace";
  projectPath?: string;
}

interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
  /**
   * 本机外部 CLI 预设探测（S6）。desktop host 注入（child_process 实现），
   * CLI 环境不注入 —— probeExternalAgents 返回 null，UI 退静态目录 + 自由输入。
   * 编排与 bootstrap 的会话绑定 v4 RPC 同源（shared/node probeExternalPresets）。
   */
  probeExternalAgents?: () => Promise<ExternalAgentPresetStatus[] | null>;
}

interface PluginAgentDiscovery {
  profiles: AgentSummary[];
  runtimeAgents: AgentSummary[];
}

const BUILT_IN_AGENT_NAMES = new Set(["general-purpose", "Explore"]);
const PLUGIN_MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
] as const;

function createBuiltInAgents(
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
  executionChannel: BuiltInExecutionChannelOverrides = {},
): AgentSummary[] {
  const generalPurposeOverride = modelSelectionOverrides["general-purpose"];
  const exploreOverride = modelSelectionOverrides.Explore;
  const generalChannel = executionChannel["general-purpose"];
  const exploreChannel = executionChannel.Explore;
  return [
    {
      id: createAgentStateId({
        name: "general-purpose",
        scope: "built-in",
        source: "built-in",
      }),
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
      color: "blue",
      injectAgentsMd: true,
      modelSelection: generalChannel ? undefined : generalPurposeOverride,
      modelSelectionOverride: generalChannel ? undefined : generalPurposeOverride,
      systemPrompt: "",
      tools: ["*"],
      ...(generalChannel
        ? {
            backend: "external" as const,
            presetId: generalChannel.presetId,
            ...(generalChannel.model ? { externalModel: generalChannel.model } : {}),
            ...(generalChannel.effort ? { externalEffort: generalChannel.effort } : {}),
            ...(generalChannel.contextWindow !== undefined
              ? { externalContextWindow: generalChannel.contextWindow }
              : {}),
          }
        : {}),
      path: "built-in:general-purpose",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreChannel ? undefined : exploreOverride,
      modelSelectionOverride: exploreChannel ? undefined : exploreOverride,
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      ...(exploreChannel
        ? {
            backend: "external" as const,
            presetId: exploreChannel.presetId,
            ...(exploreChannel.model ? { externalModel: exploreChannel.model } : {}),
            ...(exploreChannel.effort ? { externalEffort: exploreChannel.effort } : {}),
            ...(exploreChannel.contextWindow !== undefined
              ? { externalContextWindow: exploreChannel.contextWindow }
              : {}),
          }
        : {}),
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}

function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    builtInExecutionChannel: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

/**
 * state 文件的 builtInExecutionChannel → 收敛后的覆盖表（S7）。
 *
 * 三条防线之二（第三道在 core 的 normalizeAgentProfiles）：未知 key 丢弃、形状
 * 不对丢弃、preset 未标 subagentChannelReady 丢弃；Explore 额外要求 preset 声明
 * 只读档位——与 core 的收敛口径一致，手改 JSON 绕不过。
 */
function normalizeBuiltInExecutionChannel(value: unknown): BuiltInExecutionChannelOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: BuiltInExecutionChannelOverrides = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "general-purpose" && key !== "Explore") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const presetId = (entry as { presetId?: unknown }).presetId;
    if (typeof presetId !== "string" || presetId.trim().length === 0) continue;
    const preset = findExternalAgentPreset(presetId.trim());
    if (!isChannelReadyPreset(presetId.trim())) continue;
    if (key === "Explore" && preset?.readOnlyPermissionMode === undefined) continue;
    const record = entry as Record<string, unknown>;
    // 子字段级清洗：非法的 model/effort/contextWindow 丢弃，presetId 合法即保留
    //（渠道本身可用，坏的是细配置——整条丢弃反而把用户的渠道选择也丢了）。
    const model = record.model;
    const effort = record.effort;
    const contextWindow = record.contextWindow;
    result[key] = {
      presetId: presetId.trim(),
      ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
      ...(typeof effort === "string" && effort.trim().length > 0 ? { effort: effort.trim() } : {}),
      ...(typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {}),
    };
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  return readAgentStateAtPath(await resolveSubagentStateFile(options));
}

async function readAgentStateAtPath(stateFile: string): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(stateFile);
  try {
    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      builtInExecutionChannel?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      builtInModelOverrides?: unknown;
      builtInThoughtLevelOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    const selections = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    return {
      ...parsed,
      builtInModelSelectionOverrides: selections,
      builtInExecutionChannel: normalizeBuiltInExecutionChannel(parsed.builtInExecutionChannel),
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
    };
  } catch (error) {
    // 文件缺失/损坏沿用既有空覆盖语义；IO 失败不能伪装为空配置并重新启用已禁用 agent。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyAgentsState();

    throw error;
  }
}

async function writeAgentStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

async function discoverFileAgents(params: {
  diagnostics: AgentDiagnostic[];
  includeUserAgents: boolean;
  includeWorkspaceAgents: boolean;
  storageOptions?: SubagentStorageOptions;
  workspacePath: string;
}): Promise<AgentSummary[]> {
  const roots: Array<{ scope: AgentScope; rootPath: string }> = [];
  if (params.includeUserAgents) {
    roots.push({
      scope: "user",
      rootPath: await resolveUserSubagentRoot(params.storageOptions),
    });
  }
  if (params.includeWorkspaceAgents) {
    roots.push({
      scope: "workspace",
      rootPath: resolveWorkspaceSubagentRoot(params.workspacePath),
    });
  }

  const agents: AgentSummary[] = [];
  for (const root of roots) {
    for (const agentPath of await collectAgentMarkdownPaths(root.rootPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: root.scope,
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          agents.push({
            ...parsed.agent,
            projectPath: root.scope === "workspace" ? params.workspacePath : undefined,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  return agents;
}

export async function collectAgentMarkdownPaths(
  rootPath: string,
  recursive = false,
): Promise<string[]> {
  if (!(await exists(rootPath))) {
    return [];
  }

  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const result: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      // 自定义 profile 只支持第一层；插件保留已有递归发现规则。
      if (recursive) result.push(...(await collectAgentMarkdownPaths(entryPath, true)));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

async function discoverPluginAgents(params: {
  diagnostics: AgentDiagnostic[];
  state: AgentsStateFile;
  reservedNames: Iterable<string>;
  storageOptions?: SubagentStorageOptions;
}): Promise<PluginAgentDiscovery> {
  const storageRoot = await resolveZCodeStorageRoot(params.storageOptions);
  const cliStorageRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const pluginConfig = await readPluginConfig(params.storageOptions);
  const records = await readEnabledPluginRecords(join(cliStorageRoot, "plugins"), pluginConfig);
  const parsedAgents: Array<{
    agent: AgentSummary;
    bareName: string;
    pluginName: string;
  }> = [];

  for (const record of records) {
    for (const agentPath of await collectPluginAgentMarkdownPaths(record.installPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: record.scope === "workspace" ? "workspace" : "user",
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          const id = createPluginAgentStateId(record.id, parsed.agent.name);
          parsedAgents.push({
            agent: applyPluginAgentOverrides(
              {
                ...parsed.agent,
                id,
                name: `${record.name}:${parsed.agent.name}`,
                readOnly: true,
                source: "plugin",
                pluginId: record.id,
                pluginName: record.name,
                projectPath: record.scope === "workspace" ? record.projectPath : undefined,
              },
              params.state,
            ),
            bareName: parsed.agent.name,
            pluginName: record.name,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read plugin agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  const reservedNames = new Set([...BUILT_IN_AGENT_NAMES, ...params.reservedNames]);
  const bareNameCounts = new Map<string, number>();
  for (const parsed of parsedAgents) {
    bareNameCounts.set(parsed.bareName, (bareNameCounts.get(parsed.bareName) ?? 0) + 1);
  }

  const profiles: AgentSummary[] = [];
  const runtimeAgents: AgentSummary[] = [];
  for (const parsed of parsedAgents) {
    profiles.push(parsed.agent);
    runtimeAgents.push(parsed.agent);
    if (bareNameCounts.get(parsed.bareName) === 1 && !reservedNames.has(parsed.bareName)) {
      runtimeAgents.push({
        ...parsed.agent,
        id: createPluginAgentStateId(`${parsed.agent.id}:alias`, parsed.bareName),
        name: parsed.bareName,
      });
    } else if (reservedNames.has(parsed.bareName)) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    } else if ((bareNameCounts.get(parsed.bareName) ?? 0) > 1) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    }
  }

  return {
    // 裸名称只是同一插件 agent 的运行时调用别名，不能进入一文件一条的 UI 资源投影。
    profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    runtimeAgents: runtimeAgents.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function readPluginConfig(options?: SubagentStorageOptions): Promise<PluginConfigSummary> {
  try {
    const configPath = join(resolveUserHomeDir(options), ".zcode", "cli", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { enabledPlugins: {}, suppressedBuiltins: [] };
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    return {
      enabledPlugins: Object.fromEntries(
        Object.entries(enabledPlugins).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
      suppressedBuiltins: Array.isArray(plugins.suppressedBuiltins)
        ? plugins.suppressedBuiltins.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { enabledPlugins: {}, suppressedBuiltins: [] };
  }
}

/** 内置插件没有安装记录，只扫描 installed 文件会漏掉；缓存只补缺失身份，不能复活禁用/卸载插件。 */
async function readEnabledPluginRecords(
  pluginStorageRoot: string,
  config: PluginConfigSummary,
): Promise<InstalledPluginRecord[]> {
  const installed = await readInstalledPluginRecords(pluginStorageRoot);
  const records = installed.filter(
    (record) =>
      config.enabledPlugins[record.id] === true &&
      // 卸载抑制优先于遗留的安装/启用记录，不能只在缓存兜底时检查而复活官方插件。
      !(
        record.id.endsWith(`@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`) &&
        config.suppressedBuiltins.includes(record.id)
      ),
  );
  const seenIds = new Set(installed.map((record) => record.id));
  for (const cacheRoot of await scanOfficialPluginCacheRoots(pluginStorageRoot)) {
    const id = `${cacheRoot.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
    if (seenIds.has(id) || config.suppressedBuiltins.includes(id)) continue;
    const enabled = config.enabledPlugins[id] ?? DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(id);
    if (!enabled) continue;
    for (const versionRoot of cacheRoot.versionRoots) {
      const manifest = await readPluginManifest(versionRoot);
      if (manifest?.name !== cacheRoot.name) continue;
      records.push({ id, installPath: versionRoot, name: cacheRoot.name, scope: "user" });
      seenIds.add(id);
      break;
    }
  }
  return records;
}

async function readInstalledPluginRecords(
  pluginStorageRoot: string,
): Promise<InstalledPluginRecord[]> {
  try {
    const raw = await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf-8");
    const parsed = JSON.parse(raw) as InstalledPluginsStateFile;
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.filter(isInstalledPluginRecord);
  } catch {
    return [];
  }
}

function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.name === "string"
  );
}

async function collectPluginAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  const manifest = await readPluginManifest(rootPath);
  const roots = collectPluginAgentRoots(rootPath, manifest?.agents);
  const paths = await Promise.all(roots.map((root) => collectAgentMarkdownPaths(root, true)));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<Record<string, unknown> | null> {
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    try {
      const raw = await readFile(join(rootPath, relativePath), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next supported manifest path.
    }
  }
  return null;
}

function collectPluginAgentRoots(rootPath: string, manifestAgents: unknown): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const root = resolve(rootPath);
  const add = (relativePath: string) => {
    const resolved = resolve(root, relativePath.replace(/^\.\//u, ""));
    const relativeToRoot = relative(root, resolved);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  };
  add("agents");
  if (typeof manifestAgents === "string") add(manifestAgents);
  if (Array.isArray(manifestAgents)) {
    for (const value of manifestAgents) {
      if (typeof value === "string") add(value);
    }
  }
  return roots;
}

function applyPluginAgentOverrides(agent: AgentSummary, state: AgentsStateFile): AgentSummary {
  const override = state.pluginAgentModelSelectionOverrides[agent.id];
  // 插件文件只提供默认值；覆盖替换整份选择，不能混入原模型的档位。
  return {
    ...agent,
    defaultModelSelection: agent.modelSelection,
    ...(override ? { modelSelection: override, modelSelectionOverride: override } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

export function createSubagentsService(options?: SubagentsServiceOptions): ISubagentsService & {
  /** Host 启动/重启 Agent 前准备配置，不暴露为 Renderer RPC。 */
  prepareRuntimeState(workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  readRuntimeConfig(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SubagentRuntimeConfig>;
  disposeAll(): void;
} {
  let writeQueue = Promise.resolve();
  let disposed = false;
  const storageOptions: SubagentsServiceOptions = {
    homeDir: options?.homeDir,
  };

  const runtimeConfig = createSubagentRuntimeConfigCache({
    readUserRoot: () => resolveUserSubagentRoot(storageOptions),
    readStatePath: () => resolveSubagentStateFile(storageOptions),
    readState: readAgentStateAtPath,
  });
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(run, run);
    writeQueue = queued.then(
      () => {},
      () => {},
    );
    return queued;
  }
  function mutate<T>(run: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      if (disposed) throw new Error("Subagents service is disposed");
      return run();
    });
  }
  const service = {
    readRuntimeConfig: runtimeConfig.read,
    disposeAll() {
      disposed = true;
      runtimeConfig.dispose();
    },
    async prepareRuntimeState(workspace?: { workspacePath: string; workspaceIdentity?: string }) {
      return enqueue(async () => {
        const markdownMigration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of markdownMigration.failures)
          subagentLogger.warn(undefined, "用户 Subagent Markdown 迁移失败，保留原文件", failure);
        // state 的迁移由缓存读取入口统一执行，IO 失败同样发布回退，不能提前阻断 CLI 启动。
        await runtimeConfig.prepare(workspace);
      });
    },

    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      mode?: SubagentsListMode;
    }): Promise<AgentsListResult> {
      const capability = resolveCapabilities(options);
      const mode = params.mode ?? "allRuntimeScopes";
      const diagnostics: AgentDiagnostic[] = [];
      if (capability.userScopeAvailable) {
        const migration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of migration.failures)
          diagnostics.push({
            code: "agent_read_failed",
            message: "Subagent Markdown migration failed; original file preserved",
            path: failure.path,
          });
      }
      const state = await readAgentStateFile(storageOptions);
      const builtInAgents = createBuiltInAgents(
        state.builtInModelSelectionOverrides,
        state.builtInExecutionChannel,
      );
      const fileAgents = await discoverFileAgents({
        diagnostics,
        includeUserAgents: capability.userScopeAvailable,
        includeWorkspaceAgents: mode === "allRuntimeScopes",
        storageOptions,
        workspacePath: params.workspacePath,
      });
      const sortedUserAgents = fileAgents
        .filter((agent) => agent.scope === "user")
        .sort((left, right) => left.name.localeCompare(right.name));
      const sortedWorkspaceAgents = fileAgents
        .filter((agent) => agent.scope === "workspace")
        .sort((left, right) => left.name.localeCompare(right.name));
      // 用户页不能读项目 profile，但仍需展示本地插件的只读覆盖入口；不能把两者一并剪掉。
      const pluginAgentDiscovery = await discoverPluginAgents({
        diagnostics,
        state,
        reservedNames: [
          ...builtInAgents.map((agent) => agent.name),
          ...sortedUserAgents.map((agent) => agent.name),
          ...sortedWorkspaceAgents.map((agent) => agent.name),
        ],
        storageOptions,
      });
      const discoveredAgents =
        mode === "settingsUserOnly"
          ? [...builtInAgents, ...sortedUserAgents]
          : applyRuntimePrecedence([
              ...builtInAgents,
              ...sortedUserAgents,
              ...sortedWorkspaceAgents,
              ...pluginAgentDiscovery.runtimeAgents,
            ]);
      const agents = attachEnabledState(discoveredAgents, state);

      return {
        agents,
        userAgents: agents.filter((agent) => agent.source === "user"),
        pluginAgents: attachEnabledState(pluginAgentDiscovery.profiles, state),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: { agentId: string; enabled: boolean }): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const previous = new Set(state.disabledAgentIds);
        if (params.enabled) {
          previous.delete(params.agentId);
        } else {
          previous.add(params.agentId);
        }
        state.disabledAgentIds = [...previous].sort();
        await writeAgentStateFile(state, storageOptions);
      };

      await mutate(runUpdate);
    },

    async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const builtInModelSelectionOverrides = {
          ...state.builtInModelSelectionOverrides,
        };
        const modelSelection = normalizeSubagentModelSelection(params.modelSelection);
        if (modelSelection) {
          builtInModelSelectionOverrides[params.agentName] = modelSelection;
        } else {
          delete builtInModelSelectionOverrides[params.agentName];
        }
        await writeAgentStateFile(
          {
            ...state,
            builtInModelSelectionOverrides,
          },
          storageOptions,
        );
      };

      await mutate(runUpdate);
    },

    async setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void> {
      if (!params.agentId.startsWith("plugin:") || params.agentId.trim() !== params.agentId)
        throw new Error("无效插件 Subagent 身份");
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const overrides = { ...state.pluginAgentModelSelectionOverrides };
        const selection = normalizeSubagentModelSelection(params.modelSelection);
        if (selection) overrides[params.agentId] = selection;
        else delete overrides[params.agentId];
        await writeAgentStateFile(
          { ...state, pluginAgentModelSelectionOverrides: overrides },
          storageOptions,
        );
      };
      await mutate(runUpdate);
    },

    async setBuiltInExecutionChannel(params: {
      agentName: "general-purpose" | "Explore";
      /** undefined = 恢复 ZCode 内置执行。 */
      presetId?: string;
      /** 传给 CLI 的模型名（原样透传）；缺省 = CLI 默认。 */
      model?: string;
      /** 推理档位；探测目录含所选模型时必须在其候选内（与 S6 UI 规则同口径）。 */
      effort?: string;
      /** 上下文窗口（token）；UI 首期不暴露。 */
      contextWindow?: number;
    }): Promise<void> {
      const runUpdate = async () => {
        const presetId = params.presetId?.trim();
        if (!presetId) {
          // 清除：恢复 native。
          const state = await readAgentStateFile(storageOptions);
          const next = { ...state.builtInExecutionChannel };
          delete next[params.agentName];
          await writeAgentStateFile({ ...state, builtInExecutionChannel: next }, storageOptions);
          return;
        }
        // ── fail-closed 校验（D3/D5）──
        if (!isChannelReadyPreset(presetId)) {
          throw new Error(`外部 CLI 预设未开启执行渠道：${presetId}`);
        }
        const preset = findExternalAgentPreset(presetId)!;
        if (params.agentName === "Explore" && preset.readOnlyPermissionMode === undefined) {
          throw new Error(`预设 ${presetId} 未声明只读模式，不能承接 Explore`);
        }
        // 装机探测（S6 数据源）：探测实现未注入（CLI 环境）时跳过——该环境没有 UI 入口。
        if (options?.probeExternalAgents) {
          const statuses = await options.probeExternalAgents();
          if (statuses) {
            const status = statuses.find((entry) => entry.preset.id === presetId);
            if (!status || status.probeError) {
              throw new Error(
                `无法确认 ${preset.label} 可用（探测失败），已拒绝启用执行渠道；可稍后重试`,
              );
            }
            if (!status.installed) {
              throw new Error(`${preset.label} 未安装，已拒绝启用执行渠道`);
            }
            // 档位值域（S6 同口径）：探测目录含所选模型时，effort 必须在其候选内；
            // 目录没有该模型条目（自由输入模型）时不强校验——值域权威在 CLI 侧。
            const probedModel = params.model?.trim();
            const probedEffort = params.effort?.trim();
            if (probedEffort && probedModel) {
              const entry = status.modelCatalog.find((item) => item.id === probedModel);
              if (entry && !entry.supportedEfforts.includes(probedEffort)) {
                throw new Error(
                  `模型 ${probedModel} 不支持档位 ${probedEffort}（可选：${entry.supportedEfforts.join(", ") || "无"}）`,
                );
              }
            }
          }
        }
        const model = params.model?.trim();
        const effort = params.effort?.trim();
        if (model !== undefined && model.length === 0) {
          throw new Error("外部渠道模型名为空时应省略字段，而不是传空串");
        }
        if (effort !== undefined && effort.length === 0) {
          throw new Error("外部渠道档位为空时应省略字段，而不是传空串");
        }
        if (
          params.contextWindow !== undefined &&
          (!Number.isInteger(params.contextWindow) || params.contextWindow < 1)
        ) {
          throw new Error("外部渠道上下文窗口必须是正整数（token）");
        }
        const state = await readAgentStateFile(storageOptions);
        await writeAgentStateFile(
          {
            ...state,
            builtInExecutionChannel: {
              ...state.builtInExecutionChannel,
              [params.agentName]: {
                presetId,
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(params.contextWindow !== undefined
                  ? { contextWindow: params.contextWindow }
                  : {}),
              },
            },
          },
          storageOptions,
        );
      };
      await mutate(runUpdate);
    },

    async getPrimaryUserAgentsDirectory(_params: { provider: ZCodeProvider }): Promise<{
      path: string;
    }> {
      const path = await resolveUserSubagentRoot(storageOptions);
      await mkdir(path, { recursive: true });
      return { path };
    },

    async createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
      if (await exists(filePath)) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 先验证即将写入的 Markdown 可解析，避免 serializer 回归时把坏 profile 落盘。
      await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
      return { agent };
    },

    async updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });

      if (params.oldFilePath && params.oldFilePath !== filePath && (await exists(filePath))) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 更新时同样先 parse 再覆盖旧文件，避免失败保存破坏已有用户 agent。
      await writeFile(filePath, content, "utf-8");
      // enabled 状态按 agent id 存储；重命名会生成新 id，必须迁移旧禁用记录，
      // 否则用户禁用的 agent 改名后会被 runtime 当成新启用 profile 重新加载。
      await migrateDisabledAgentId(params.agentId, agent.id, storageOptions);
      if (params.oldFilePath && params.oldFilePath !== filePath) {
        await rm(params.oldFilePath, { force: true });
      }
      return { agent };
    },

    async deleteAgent(params: AgentDeleteParams): Promise<void> {
      await rm(params.filePath, { force: true });

      const state = await readAgentStateFile(storageOptions);
      const disabledSet = new Set(state.disabledAgentIds);
      disabledSet.delete(params.agentId);
      state.disabledAgentIds = [...disabledSet].sort();
      await writeAgentStateFile(state, storageOptions);
    },

    async probeExternalAgents(): Promise<ExternalAgentPresetStatus[] | null> {
      if (!options?.probeExternalAgents) return null;
      return await options.probeExternalAgents();
    },
  };
  return {
    ...service,
    createAgent: (params: AgentCreateParams) => mutate(() => service.createAgent(params)),
    updateAgent: (params: AgentUpdateParams) => mutate(() => service.updateAgent(params)),
    deleteAgent: (params: AgentDeleteParams) => mutate(() => service.deleteAgent(params)),
  };
}

function validateUserAgentConfig(config: SubAgentConfig): void {
  if (config.backend === "external") {
    validateExternalAgentConfig(config);
    return;
  }
  const trimmedName = config.name.trim();
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  const minNameLength = 3;
  const maxNameLength = 50;
  if (trimmedName.length < minNameLength || trimmedName.length > maxNameLength) {
    throw new Error(`Name must be between ${minNameLength} and ${maxNameLength} characters`);
  }
  if (!nameRegex.test(trimmedName)) {
    throw new Error("Name can only contain letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
}

/**
 * 外部 profile 的保存校验。与 runtime parser（parseExternalBackend）同口径：
 * preset 必须是已知且完整适配的预设，否则 runtime 加载时会拒绝，保存端提前挡下。
 * model/effort 是 CLI 透传字符串，值域由 CLI 运行时判定，这里只做非空校验。
 */
function validateExternalAgentConfig(config: SubAgentConfig): void {
  const trimmedName = config.name.trim();
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  if (trimmedName.length < 3 || trimmedName.length > 50 || !nameRegex.test(trimmedName)) {
    throw new Error("Name must be 3-50 characters of letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
  const presetId = config.presetId?.trim();
  if (!presetId) {
    throw new Error("外部 agent 必须选择预设（preset）");
  }
  const preset = findExternalAgentPreset(presetId);
  if (!preset) {
    throw new Error(`未知外部 agent 预设: ${presetId}`);
  }
  if (preset.adaptation !== "full") {
    throw new Error(`外部 agent 预设 ${presetId} 未完整适配，不可绑定`);
  }
  if (config.externalModel !== undefined && config.externalModel.trim().length === 0) {
    throw new Error("外部 agent 模型名为空时应省略字段，而不是传空串");
  }
  if (config.externalEffort !== undefined && config.externalEffort.trim().length === 0) {
    throw new Error("外部 agent 推理档位为空时应省略字段，而不是传空串");
  }
  if (
    config.externalContextWindow !== undefined &&
    (!Number.isInteger(config.externalContextWindow) || config.externalContextWindow < 1)
  ) {
    throw new Error("外部 agent 上下文窗口必须是正整数（token）");
  }
}

function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

async function migrateDisabledAgentId(
  previousAgentId: string,
  nextAgentId: string,
  options?: SubagentStorageOptions,
): Promise<void> {
  if (previousAgentId === nextAgentId) {
    return;
  }
  const state = await readAgentStateFile(options);
  const disabledSet = new Set(state.disabledAgentIds);
  if (!disabledSet.has(previousAgentId)) {
    return;
  }
  disabledSet.delete(previousAgentId);
  disabledSet.add(nextAgentId);
  return writeAgentStateFile(
    {
      ...state,
      disabledAgentIds: [...disabledSet].sort(),
    },
    options,
  );
}

function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
    ...(config.externalModel !== undefined ? { externalModel: config.externalModel.trim() } : {}),
    ...(config.externalEffort !== undefined
      ? { externalEffort: config.externalEffort.trim() }
      : {}),
  };
}

function requireWorkspacePath(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

function parseSavedAgent(
  content: string,
  path: string,
  scope: "user" | "workspace",
  workspacePath?: string,
): AgentSummary {
  const parsed = parseSubagentMarkdown({
    content,
    path,
    scope,
  });
  if (parsed.diagnostic || !parsed.agent) {
    throw new Error(parsed.diagnostic?.message ?? `Failed to parse saved agent: ${path}`);
  }
  return {
    ...parsed.agent,
    projectPath: scope === "workspace" ? workspacePath : undefined,
  };
}
