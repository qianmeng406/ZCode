import { execFile } from "node:child_process";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  ORACLE_DEEP_REVIEW_QUERY_SOURCE,
  ORACLE_DEEP_REVIEW_TIMEOUT_MS,
  ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
  ORACLE_TURN_REVIEW_QUERY_SOURCE,
  buildOracleReviewPrompt,
  formatOracleCommitLine,
  parseOracleVerdict,
  splitUnifiedDiffIntoOracleSections,
  type OracleDiffSection,
  type OracleVerdict,
} from "@zcode/shared/oracle-review";
import type { ZCodeApp } from "@zcode/bootstrap";
import type { RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { BootstrapModule, RunDependencies } from "./cli-types.js";

/**
 * `zcode review`：用 Oracle 审查规则检查工作区或提交范围的改动。
 *
 * 与桌面端的会话内审查共用同一套 prompt / verdict / diff 排除规则
 * （@zcode/shared/oracle-review），差别只在材料来源：这里没有对话回合，
 * 改动本身就是审查对象（materialKind="diff"）。
 *
 * 不做会话持久化：没有 session 就没有 conversation_review 记录，`--json` 即产物。
 */

const USAGE = `Usage:
  zcode review [options]

Review the current changes with the Oracle reviewer (a second model pass).

Target (default: working tree vs HEAD):
  --base <ref>            Review <ref>...HEAD (pull-request range)
  --staged                Review staged changes only

Options:
  --deep                  Read-only tool loop for evidence gathering (slower, costlier)
  --model <provider/model>  Reviewer model (default: configured CLI default model)
  --fail-on <fail|warn|never>  Exit 1 when the verdict reaches this level (default: fail)
  --timeout <seconds>     Override the request budget (default: 600, or 1200 with --deep)
  --max-diff-bytes <n>    Budget for included diff text (default: 800000)
  --no-commits            Do not include recent commit subjects in the prompt
  --json                  Print a machine-readable report

Exit codes: 0 not blocked, 1 blocked by --fail-on, 2 operational error.
`;

const DEFAULT_MAX_DIFF_BYTES = 800_000;
const RECENT_COMMIT_COUNT = 8;
/** git 输出的保护上限：比审查预算宽得多，只用于防止异常输出把进程撑爆。 */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

type FailOn = "fail" | "warn" | "never";
const FAIL_ON_VALUES = new Set<FailOn>(["fail", "warn", "never"]);

export interface ReviewCommandFlags {
  base?: string;
  staged?: boolean;
  deep?: boolean;
  json?: boolean;
  model?: string;
  failOn?: string;
  timeoutSeconds?: string;
  maxDiffBytes?: string;
  noCommits?: boolean;
}

export interface ReviewCommandDependencies extends RunDependencies {
  loadBootstrapModule?: () => Promise<BootstrapModule>;
  /** 注入点：单测不需要真实仓库。返回 stdout，失败时抛错。 */
  runGit?: (args: readonly string[], cwd: string) => Promise<string>;
}

interface ReviewPlan {
  readonly staged: boolean;
  readonly base?: string;
  readonly deep: boolean;
  readonly json: boolean;
  readonly failOn: FailOn;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maxDiffBytes: number;
  readonly includeCommits: boolean;
}

interface ReviewEvidence {
  readonly source: "working-tree" | "staged" | "base";
  /** 人类可读的范围描述，同时进 JSON 的 diff 字段。 */
  readonly ref?: string;
  readonly sections: readonly OracleDiffSection[];
  readonly fileCount: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly excluded: number;
  readonly commits: readonly string[];
  readonly completenessNotes: readonly string[];
}

function reviewError(ctx: RunContext, json: boolean, code: string, message: string): number {
  if (json) {
    ctx.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, error: { code, message } }, null, 2)}\n`,
    );
  } else {
    ctx.stderr.write(`Error: ${message}\n${code === "usage" ? `\n${USAGE}` : ""}`);
  }
  return 2;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseReviewFlags(flags: ReviewCommandFlags): ReviewPlan | { error: string } {
  if (flags.staged === true && flags.base !== undefined) {
    return { error: "--staged and --base are mutually exclusive." };
  }
  const failOn = (flags.failOn ?? "fail").trim().toLowerCase();
  if (!FAIL_ON_VALUES.has(failOn as FailOn)) {
    return { error: `Unsupported --fail-on value: ${flags.failOn}. Use fail, warn, or never.` };
  }
  const timeoutSeconds = parsePositiveInt(flags.timeoutSeconds);
  if (flags.timeoutSeconds !== undefined && timeoutSeconds === undefined) {
    return {
      error: `--timeout expects a positive number of seconds, got: ${flags.timeoutSeconds}`,
    };
  }
  const maxDiffBytes = parsePositiveInt(flags.maxDiffBytes);
  if (flags.maxDiffBytes !== undefined && maxDiffBytes === undefined) {
    return { error: `--max-diff-bytes expects a positive integer, got: ${flags.maxDiffBytes}` };
  }
  const deep = flags.deep === true;
  return {
    staged: flags.staged === true,
    ...(flags.base?.trim() ? { base: flags.base.trim() } : {}),
    deep,
    json: flags.json === true,
    failOn: failOn as FailOn,
    ...(flags.model?.trim() ? { model: flags.model.trim() } : {}),
    timeoutMs:
      timeoutSeconds !== undefined
        ? timeoutSeconds * 1_000
        : deep
          ? ORACLE_DEEP_REVIEW_TIMEOUT_MS
          : ORACLE_REVIEW_REQUEST_TIMEOUT_MS,
    maxDiffBytes: maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    includeCommits: flags.noCommits !== true,
  };
}

function defaultRunGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail =
            typeof stderr === "string" && stderr.trim() ? stderr.trim() : error.message;
          reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function diffArgsFor(plan: Pick<ReviewPlan, "staged" | "base">): string[] {
  const common = ["--no-color", "--no-ext-diff", "-U3"];
  if (plan.staged) return ["diff", "--cached", ...common];
  if (plan.base) return ["diff", `${plan.base}...HEAD`, ...common];
  return ["diff", "HEAD", ...common];
}

function parseCommitSubjects(logOutput: string): string[] {
  const lines: string[] = [];
  for (const raw of logOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-f]{4,40})\s+(.*)$/i.exec(line);
    if (match) {
      lines.push(formatOracleCommitLine(match[1] ?? "", match[2] ?? ""));
      continue;
    }
    // --pretty 的输出必然带 hash；异常行原样保留（截断），不要静默丢掉证据。
    lines.push(formatOracleCommitLine("", line));
  }
  return lines;
}

async function collectReviewEvidence(params: {
  cwd: string;
  plan: ReviewPlan;
  runGit: (args: readonly string[], cwd: string) => Promise<string>;
}): Promise<ReviewEvidence> {
  const { cwd, plan, runGit } = params;
  const diffText = await runGit(diffArgsFor(plan), cwd);
  const split = splitUnifiedDiffIntoOracleSections(diffText, { maxBytes: plan.maxDiffBytes });

  const commits = plan.includeCommits
    ? parseCommitSubjects(
        await runGit(["log", `-${RECENT_COMMIT_COUNT}`, "--pretty=format:%h %s"], cwd).catch(
          () => "",
        ),
      )
    : [];

  const completenessNotes: string[] = [];
  if (split.truncated) {
    completenessNotes.push(
      "改动数量或体积超出本次取数预算，部分文件未包含在审查材料里；结论只覆盖已纳入的改动。",
    );
  }
  if (split.excluded > 0) {
    completenessNotes.push(
      `${split.excluded} 个改动文件属于依赖/构建/内部目录，按仓库规则不参与审查。`,
    );
  }
  if (!plan.includeCommits) {
    completenessNotes.push("本次审查未包含最近提交摘要（--no-commits）。");
  }

  return {
    source: plan.staged ? "staged" : plan.base ? "base" : "working-tree",
    ...(plan.base
      ? { ref: `${plan.base}...HEAD` }
      : plan.staged
        ? { ref: "--cached" }
        : { ref: "HEAD" }),
    sections: split.sections,
    fileCount: split.fileCount,
    bytes: split.bytes,
    truncated: split.truncated,
    excluded: split.excluded,
    commits,
    completenessNotes,
  };
}

function parseProviderModelFlag(value: string): ModelSelection | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/**
 * 补齐审查请求的执行选项。
 *
 * 推理档位：模型声明了档位而选择里没有时，取声明表里的默认档（注册表规则：
 * 默认档 = 最后一档）。不补会被 modelFactory 以 "Reasoning level is required"
 * 直接拒掉——这条规则与 GUI picker / subagent_model 解析同源。
 */
function resolveReviewSelection(
  app: ZCodeApp,
  requested: ModelSelection | undefined,
): { selection: ModelSelection; maxOutputTokens?: number } | undefined {
  if (!requested) return undefined;
  const option = app.getModelOption?.(requested);
  const defaultLevel = option?.reasoning?.defaultLevel;
  const selection: ModelSelection =
    requested.options?.reasoningLevel === undefined && defaultLevel
      ? { ...requested, options: { ...requested.options, reasoningLevel: defaultLevel } }
      : requested;
  const maxOutputTokens = option?.maxOutputTokens;
  return {
    selection,
    ...(typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
  };
}

function resolveExitCode(verdict: OracleVerdict, failOn: FailOn): number {
  if (failOn === "never") return 0;
  if (verdict === "fail") return 1;
  if (failOn === "warn" && verdict === "warn") return 1;
  return 0;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

function formatHumanReport(input: {
  verdict: OracleVerdict;
  summary: string;
  findings: string;
  requirements?: string;
  scope?: string;
  limits?: string;
  model: ModelSelection;
  deep: boolean;
  evidence: ReviewEvidence;
  elapsedMs: number;
  outputTokens?: number;
}): string {
  const { evidence, verdict } = input;
  const lines = [
    `Oracle review · ${input.deep ? "deep" : "standard"} · ${input.model.providerId}/${input.model.modelId}`,
    `target: ${evidence.source}${evidence.ref ? ` (${evidence.ref})` : ""} · ${evidence.fileCount} file(s) · ${formatBytes(evidence.bytes)}${evidence.truncated ? " · truncated" : ""}`,
    "",
    `VERDICT: ${verdict.toUpperCase()}`,
    `SUMMARY: ${input.summary || "(none)"}`,
    "",
    "FINDINGS:",
    input.findings.trim() || "(none)",
  ];
  if (input.requirements) lines.push("", "REQUIREMENTS:", input.requirements);
  if (input.scope) lines.push("", `SCOPE: ${input.scope}`);
  if (input.limits) lines.push(`LIMITS: ${input.limits}`);
  lines.push(
    "",
    `elapsed: ${(input.elapsedMs / 1000).toFixed(1)}s${input.outputTokens !== undefined ? ` · output tokens: ${input.outputTokens}` : ""}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function runReviewCommand(
  ctx: RunContext,
  flags: ReviewCommandFlags,
  deps: ReviewCommandDependencies,
  version: string,
): Promise<number> {
  const parsed = parseReviewFlags(flags);
  if ("error" in parsed) return reviewError(ctx, flags.json === true, "usage", parsed.error);
  const plan = parsed;
  const cwd = (deps.cwd ?? process.cwd)();
  const runGit = deps.runGit ?? defaultRunGit;

  const evidence = await collectReviewEvidence({ cwd, plan, runGit }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (evidence instanceof Error) {
    return reviewError(ctx, plan.json, "git", evidence.message);
  }
  if (evidence.sections.length === 0) {
    return reviewError(
      ctx,
      plan.json,
      "no-diff",
      `No reviewable ${plan.staged ? "staged " : ""}changes found (cwd: ${cwd}).`,
    );
  }

  const prompt = buildOracleReviewPrompt({
    materialKind: "diff",
    depth: plan.deep ? "deep" : "standard",
    diffSections: evidence.sections,
    ...(evidence.commits.length > 0 ? { recentCommits: evidence.commits } : {}),
    completenessNotes: evidence.completenessNotes,
  });

  const startedAt = Date.now();
  let app: ZCodeApp | undefined;
  let registryRuntime: { dispose?: () => void } | undefined;
  let shutdownTelemetry: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("review deadline exceeded")),
    plan.timeoutMs,
  );
  try {
    const bootstrap = deps.loadBootstrapModule ?? loadBootstrapModule;
    const module = await bootstrap();
    const env = deps.env ?? process.env;
    const prepareTelemetry = deps.prepareZCodeTelemetryEnv ?? module.prepareZCodeTelemetryEnv;
    const appEnv = prepareTelemetry
      ? await prepareTelemetry(env, {
          cliVersion: version,
          productVersion: env.ZCODE_APP_VERSION,
        })
      : env;
    shutdownTelemetry = deps.shutdownZCodeTelemetry ?? module.shutdownZCodeTelemetry;
    const startRegistry =
      deps.startProcessProviderRegistryRuntime ?? module.startProcessProviderRegistryRuntime;
    const runtime = await startRegistry(appEnv, deps.skipUserConfig ? {} : { standalone: {} });
    registryRuntime = runtime;
    const createApp = deps.createZCodeApp ?? module.createZCodeApp;
    app = await createApp({
      modelSelectionMode: "cli-default",
      env: appEnv,
      providerRegistry: runtime.runtime.registryService,
      configuredDefaultModelSelection: runtime.configuredDefaultModelSelection,
      version,
      runtimeConfig: { workingDirectory: cwd, modelStreaming: "on" },
    });

    const requested = plan.model
      ? parseProviderModelFlag(plan.model)
      : runtime.configuredDefaultModelSelection;
    if (plan.model && !requested) {
      return reviewError(
        ctx,
        plan.json,
        "bad-model",
        `Expected --model <providerId>/<modelId>, got: ${plan.model}`,
      );
    }
    const requestOptions = resolveReviewSelection(app, requested);
    if (!requestOptions) {
      // 桌面端用户通常没有 CLI 的默认模型（桌面把选择存在会话/设置里），
      // 只报「没配置」等于让人猜 providerId（本构建里可能是 UUID）。
      const available = app
        .listModels()
        .slice(0, 5)
        .map((model) => `${model.ref.providerId}/${model.ref.modelId}`);
      return reviewError(
        ctx,
        plan.json,
        "no-model",
        [
          "No reviewer model configured.",
          available.length > 0
            ? `Available models: ${available.join(", ")}.`
            : "Configure a provider first (or run `zcode login`).",
          "Pass --model <providerId>/<modelId> to choose one.",
        ].join(" "),
      );
    }

    const result = await app.generateWorkspaceText(
      {
        selection: requestOptions.selection,
        prompt,
        querySource: plan.deep ? ORACLE_DEEP_REVIEW_QUERY_SOURCE : ORACLE_TURN_REVIEW_QUERY_SOURCE,
        stream: true,
        ...(plan.deep ? { agentic: true, deadlineAt: Date.now() + plan.timeoutMs } : {}),
        ...(requestOptions.maxOutputTokens !== undefined
          ? { maxOutputTokens: requestOptions.maxOutputTokens }
          : {}),
      },
      { abortSignal: controller.signal },
    );

    const parsedVerdict = parseOracleVerdict(result.text);
    const elapsedMs = Date.now() - startedAt;
    const outputTokens = result.usage?.outputTokens;

    if (plan.json) {
      ctx.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            verdict: parsedVerdict.verdict,
            summary: parsedVerdict.summary,
            findings: parsedVerdict.findings,
            requirements: parsedVerdict.requirements ?? null,
            scope: parsedVerdict.scope ?? null,
            limits: parsedVerdict.limits ?? null,
            model: {
              providerId: result.selection.providerId,
              modelId: result.selection.modelId,
            },
            ...(result.finishReason ? { finishReason: result.finishReason } : {}),
            ...(outputTokens !== undefined ? { usage: { outputTokens } } : {}),
            diff: {
              source: evidence.source,
              ref: evidence.ref ?? null,
              files: evidence.fileCount,
              bytes: evidence.bytes,
              truncated: evidence.truncated,
              excluded: evidence.excluded,
            },
            elapsedMs,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      ctx.stdout.write(
        formatHumanReport({
          ...parsedVerdict,
          model: result.selection,
          deep: plan.deep,
          evidence,
          elapsedMs,
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        }),
      );
    }

    return resolveExitCode(parsedVerdict.verdict, plan.failOn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return reviewError(
      ctx,
      plan.json,
      aborted ? "timeout" : "request",
      aborted ? `Review timed out after ${Math.round(plan.timeoutMs / 1000)}s.` : message,
    );
  } finally {
    clearTimeout(timer);
    if (app?.close) await app.close().catch(() => undefined);
    registryRuntime?.dispose?.();
    if (shutdownTelemetry) await shutdownTelemetry().catch(() => undefined);
  }
}
