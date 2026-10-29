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
import {
  findingFingerprint,
  parseStructuredFindings,
  prepareBaselineFile,
  readBaselineFile,
  severityForVerdict,
  writeBaselineFile,
  type StructuredFinding,
} from "./review-findings.js";

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
  --allow-empty           Treat "no reviewable changes" as success (exit 0) instead of 2
  --baseline <file>       Suppress findings already accepted in this baseline file
  --write-baseline <file> Write current findings as a baseline and exit 0 (does not block)
  --format <text|json|sarif>  Output format (default: text). SARIF is for CI code scanning
  --json                  Alias for --format json

Exit codes: 0 not blocked, 1 blocked by --fail-on, 2 operational error.
`;

const DEFAULT_MAX_DIFF_BYTES = 800_000;
const RECENT_COMMIT_COUNT = 8;
/** git 输出的保护上限：比审查预算宽得多，只用于防止异常输出把进程撑爆。 */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

type FailOn = "fail" | "warn" | "never";
const FAIL_ON_VALUES = new Set<FailOn>(["fail", "warn", "never"]);

type OutputFormat = "text" | "json" | "sarif";
const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "sarif"]);

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
  allowEmpty?: boolean;
  format?: string;
  baseline?: string;
  writeBaseline?: string;
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
  readonly format: OutputFormat;
  readonly failOn: FailOn;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly maxDiffBytes: number;
  readonly includeCommits: boolean;
  readonly allowEmpty: boolean;
  readonly baselinePath?: string;
  readonly writeBaselinePath?: string;
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

function reviewError(
  ctx: RunContext,
  machineReadable: boolean,
  code: string,
  message: string,
): number {
  if (machineReadable) {
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
  // --json 是 --format json 的别名；两者同时给出时只允许一致，避免「说了 json 却拿到 text」。
  const requestedFormat = (flags.format ?? (flags.json === true ? "json" : "text"))
    .trim()
    .toLowerCase();
  if (!OUTPUT_FORMATS.has(requestedFormat as OutputFormat)) {
    return {
      error: `Unsupported --format value: ${flags.format}. Use text, json, or sarif.`,
    };
  }
  if (flags.json === true && flags.format !== undefined && requestedFormat !== "json") {
    return { error: "--json and --format conflict: use --format json instead of both." };
  }
  const baselinePath = flags.baseline?.trim();
  const writeBaselinePath = flags.writeBaseline?.trim();
  if (baselinePath && writeBaselinePath) {
    // 一边读基线一边覆盖它，结果取决于执行顺序，属于说不清的行为。
    return { error: "--baseline and --write-baseline are mutually exclusive." };
  }
  return {
    staged: flags.staged === true,
    ...(flags.base?.trim() ? { base: flags.base.trim() } : {}),
    deep,
    format: requestedFormat as OutputFormat,
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
    allowEmpty: flags.allowEmpty === true,
    ...(baselinePath ? { baselinePath } : {}),
    ...(writeBaselinePath ? { writeBaselinePath } : {}),
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
  /** 基线相关的补充说明（抑制了多少、写到了哪里）。 */
  baselineNote?: string;
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
  if (input.baselineNote) lines.push(`BASELINE: ${input.baselineNote}`);
  lines.push(
    "",
    `elapsed: ${(input.elapsedMs / 1000).toFixed(1)}s${input.outputTokens !== undefined ? ` · output tokens: ${input.outputTokens}` : ""}`,
  );
  return `${lines.join("\n")}\n`;
}

interface SarifResult {
  ruleId: string;
  level: StructuredFinding["severity"];
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number };
    };
  }>;
}

/** 最小 SARIF 2.1.0：只声明 tool/results/invocations，够 GitHub code scanning 吃。 */
function buildSarifReport(input: {
  verdict: OracleVerdict;
  summary: string;
  findings: readonly StructuredFinding[];
  evidence: ReviewEvidence;
  model: ModelSelection;
  elapsedMs: number;
  version: string;
  baselineSuppressed?: number;
}): string {
  const results: SarifResult[] = input.findings.map((finding) => ({
    ruleId: "oracle-review-finding",
    level: finding.severity,
    message: { text: finding.message },
    ...(finding.file
      ? {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.file },
                ...(finding.line ? { region: { startLine: finding.line } } : {}),
              },
            },
          ],
        }
      : {}),
  }));
  // 裁决为 fail/warn 但模型没给出可解析的发现项时，至少让 SARIF 体现出这次红。
  if (results.length === 0 && input.verdict !== "pass") {
    results.push({
      ruleId: "oracle-review-verdict",
      level: severityForVerdict(input.verdict),
      message: { text: input.summary || `Oracle review verdict: ${input.verdict}` },
    });
  }

  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "zcode-review",
              version: input.version,
              informationUri: "https://github.com/zai-org/ZCode",
              rules: [
                {
                  id: "oracle-review-finding",
                  name: "OracleReviewFinding",
                  shortDescription: { text: "Finding reported by the Oracle reviewer" },
                  defaultConfiguration: { level: "warning" },
                },
                {
                  id: "oracle-review-verdict",
                  name: "OracleReviewVerdict",
                  shortDescription: { text: "Overall Oracle review verdict" },
                  defaultConfiguration: { level: "warning" },
                },
              ],
            },
          },
          results,
          invocations: [{ executionSuccessful: true }],
          properties: {
            oracleVerdict: input.verdict,
            oracleSummary: input.summary,
            oracleModel: `${input.model.providerId}/${input.model.modelId}`,
            oracleDiffFiles: input.evidence.fileCount,
            oracleDiffTruncated: input.evidence.truncated,
            oracleElapsedMs: input.elapsedMs,
            ...(input.baselineSuppressed !== undefined
              ? { oracleBaselineSuppressed: input.baselineSuppressed }
              : {}),
          },
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** plan 还没建立时（用法错误）也要判断「用户要的是机器可读输出」。 */
function wantsMachineOutput(flags: ReviewCommandFlags): boolean {
  if (flags.format !== undefined) {
    const format = flags.format.trim().toLowerCase();
    return format === "json" || format === "sarif";
  }
  return flags.json === true;
}

export async function runReviewCommand(
  ctx: RunContext,
  flags: ReviewCommandFlags,
  deps: ReviewCommandDependencies,
  version: string,
): Promise<number> {
  const parsed = parseReviewFlags(flags);
  if ("error" in parsed) {
    return reviewError(ctx, wantsMachineOutput(flags), "usage", parsed.error);
  }
  const plan = parsed;
  const cwd = (deps.cwd ?? process.cwd)();
  const runGit = deps.runGit ?? defaultRunGit;

  // 基线是纯本地文件：启动模型前先读写预检，路径写错不必等完整审查跑完才发现。
  const baselineFingerprints = plan.baselinePath
    ? readBaselineFile(plan.baselinePath)
    : undefined;
  if (baselineFingerprints instanceof Error) {
    return reviewError(
      ctx,
      plan.format !== "text",
      "usage",
      `Cannot read baseline: ${baselineFingerprints.message}`,
    );
  }
  if (plan.writeBaselinePath) {
    const prepareError = prepareBaselineFile(plan.writeBaselinePath);
    if (prepareError) {
      return reviewError(
        ctx,
        plan.format !== "text",
        "usage",
        `Cannot write baseline ${plan.writeBaselinePath}: ${prepareError.message}`,
      );
    }
  }

  const evidence = await collectReviewEvidence({ cwd, plan, runGit }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (evidence instanceof Error) {
    return reviewError(ctx, plan.format !== "text", "git", evidence.message);
  }
  if (evidence.sections.length === 0) {
    const emptyMessage = `No reviewable ${plan.staged ? "staged " : ""}changes found (cwd: ${cwd}).`;
    if (!plan.allowEmpty) {
      return reviewError(ctx, plan.format !== "text", "no-diff", emptyMessage);
    }
    // CI 里「PR 没有改动」是正常状态，默认按运维错误退出 2 会让整条流水线红。
    // --allow-empty 把它变成一次成功但不调用模型的结果。
    if (plan.format === "text") {
      ctx.stdout.write(`${emptyMessage} Nothing to review (--allow-empty).\n`);
    } else {
      ctx.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            verdict: "pass",
            summary: emptyMessage,
            findings: "",
            findingsStructured: [],
            requirements: null,
            scope: null,
            limits: null,
            model: null,
            diff: {
              source: evidence.source,
              ref: evidence.ref ?? null,
              files: evidence.fileCount,
              bytes: evidence.bytes,
              truncated: evidence.truncated,
              excluded: evidence.excluded,
            },
            elapsedMs: 0,
            empty: true,
          },
          null,
          2,
        )}\n`,
      );
    }
    return 0;
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
        plan.format !== "text",
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
        plan.format !== "text",
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
    const structuredFindings = parseStructuredFindings(parsedVerdict.findings, parsedVerdict.verdict);

    // 基线：写模式把当前结果落盘当"已知问题"清单；读模式把命中项从结果与裁决里摘掉。
    let keptFindings = structuredFindings;
    let suppressedFindings: StructuredFinding[] = [];
    let effectiveVerdict = parsedVerdict.verdict;
    let baselineNote: string | undefined;
    let baselineWritten: string | undefined;

    if (plan.writeBaselinePath) {
      try {
        writeBaselineFile(plan.writeBaselinePath, structuredFindings);
      } catch (error) {
        return reviewError(
          ctx,
          plan.format !== "text",
          "usage",
          `Cannot write baseline ${plan.writeBaselinePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      baselineWritten = plan.writeBaselinePath;
      baselineNote = `wrote ${structuredFindings.length} finding(s) to ${plan.writeBaselinePath}`;
    } else if (plan.baselinePath && baselineFingerprints) {
      const fingerprints = baselineFingerprints;
      suppressedFindings = structuredFindings.filter((finding) =>
        fingerprints.has(findingFingerprint(finding)),
      );
      keptFindings = structuredFindings.filter(
        (finding) => !fingerprints.has(findingFingerprint(finding)),
      );
      // 只有当「全部可定位的发现项都被基线吸收」时才降级裁决；
      // 模型给了 FAIL 却一条可解析发现都没有时，基线无从匹配，必须继续阻断。
      if (suppressedFindings.length > 0 && keptFindings.length === 0) {
        effectiveVerdict = "pass";
      }
      baselineNote =
        suppressedFindings.length > 0
          ? `${suppressedFindings.length} suppressed by ${plan.baselinePath}${effectiveVerdict === "pass" ? " (verdict downgraded to pass)" : ""}`
          : `no finding matched ${plan.baselinePath}`;
    }

    if (plan.format === "json") {
      ctx.stdout.write(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            verdict: effectiveVerdict,
            summary: parsedVerdict.summary,
            findings: parsedVerdict.findings,
            // 自由文本之外额外给一份可机读的发现项；位置只在正文里真的有 path:line 时才有。
            findingsStructured: keptFindings,
            ...(suppressedFindings.length > 0 ? { suppressedFindings } : {}),
            ...(plan.baselinePath
              ? {
                  baseline: {
                    file: plan.baselinePath,
                    suppressed: suppressedFindings.length,
                    verdictBeforeBaseline: parsedVerdict.verdict,
                  },
                }
              : {}),
            ...(baselineWritten ? { baselineWritten } : {}),
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
    } else if (plan.format === "sarif") {
      ctx.stdout.write(
        buildSarifReport({
          verdict: effectiveVerdict,
          summary: parsedVerdict.summary,
          findings: keptFindings,
          evidence,
          model: result.selection,
          elapsedMs,
          version,
          ...(plan.baselinePath ? { baselineSuppressed: suppressedFindings.length } : {}),
        }),
      );
    } else {
      ctx.stdout.write(
        formatHumanReport({
          ...parsedVerdict,
          verdict: effectiveVerdict,
          model: result.selection,
          deep: plan.deep,
          evidence,
          elapsedMs,
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(baselineNote ? { baselineNote } : {}),
        }),
      );
    }

    // 写基线是一次生成动作，用它的结果去阻断本次运行没有意义。
    if (plan.writeBaselinePath) return 0;
    return resolveExitCode(effectiveVerdict, plan.failOn);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    return reviewError(
      ctx,
      plan.format !== "text",
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
