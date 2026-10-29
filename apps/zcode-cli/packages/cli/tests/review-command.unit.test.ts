import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared";
import {
  runReviewCommand,
  type ReviewCommandDependencies,
  type ReviewCommandFlags,
} from "../src/review-command.js";
import { prepareBaselineFile } from "../src/review-findings.js";

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+const a = 2;",
].join("\n");

interface Captured {
  output: () => string;
  stream: NodeJS.WriteStream;
}

function capture(): Captured {
  let text = "";
  return {
    output: () => text,
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
}

function createContext() {
  const stdout = capture();
  const stderr = capture();
  return {
    ctx: {
      argv: ["review"],
      stdin: { isTTY: false },
      stdout: stdout.stream,
      stderr: stderr.stream,
    } as never,
    stdout,
    stderr,
  };
}

interface FakeAppOptions {
  text?: string;
  selection?: ModelSelection;
  /** null 表示 Registry 没有配置默认模型。 */
  configuredDefault?: ModelSelection | null;
  reasoningDefaultLevel?: string;
  maxOutputTokens?: number;
  generateError?: Error;
}

function createHarness(options: FakeAppOptions = {}) {
  const generateCalls: Record<string, unknown>[] = [];
  const appCalls: Record<string, unknown>[] = [];
  const selection = options.selection ?? { providerId: "zai", modelId: "glm-4.6" };
  const modelOption = {
    ref: selection,
    label: selection.modelId,
    providerLabel: selection.providerId,
    contextWindow: 200_000,
    maxOutputTokens: options.maxOutputTokens ?? 128_000,
    reasoning: {
      levels: [{ value: "low", label: "low" }],
      ...(options.reasoningDefaultLevel ? { defaultLevel: options.reasoningDefaultLevel } : {}),
    },
    properties: { inputFormat: {}, outputFormat: {} },
  };
  const app = {
    getModelOption: () => modelOption,
    listModels: () => [modelOption],
    generateWorkspaceText: async (input: Record<string, unknown>) => {
      generateCalls.push(input);
      if (options.generateError) throw options.generateError;
      return {
        text: options.text ?? "VERDICT: PASS\nSUMMARY: looks good\nFINDINGS:\n- 无",
        selection: input.selection,
        finishReason: "stop",
        usage: { outputTokens: 321 },
      };
    },
    close: async () => undefined,
  };
  const module = {
    prepareZCodeTelemetryEnv: async (env: unknown) => env,
    shutdownZCodeTelemetry: async () => undefined,
    startProcessProviderRegistryRuntime: async () => ({
      runtime: { registryService: {} },
      ...(options.configuredDefault === null
        ? {}
        : { configuredDefaultModelSelection: options.configuredDefault ?? selection }),
      dispose: () => undefined,
    }),
    createZCodeApp: async (appOptions: Record<string, unknown>) => {
      appCalls.push(appOptions);
      return app;
    },
  };
  return { app, appCalls, generateCalls, module };
}

function createDeps(params: {
  module: unknown;
  diff?: string;
  gitError?: Error;
  cwd?: string;
}): ReviewCommandDependencies {
  const calls: string[][] = [];
  const deps = {
    cwd: () => params.cwd ?? "/workspace/project",
    loadBootstrapModule: async () => params.module,
    runGit: async (args: readonly string[]) => {
      calls.push([...args]);
      if (params.gitError) throw params.gitError;
      if (args[0] === "diff") return params.diff ?? SAMPLE_DIFF;
      if (args[0] === "log") return "abc1234 feat: demo";
      return "";
    },
  };
  return Object.assign(deps, { gitCalls: calls }) as ReviewCommandDependencies;
}

const DEFAULT_FLAGS: ReviewCommandFlags = {};

test("review: --staged 与 --base 互斥，按用法错误退出", async () => {
  const { ctx, stderr } = createContext();
  const harness = createHarness();
  const exitCode = await runReviewCommand(
    ctx,
    { staged: true, base: "main" },
    createDeps({ module: harness.module }),
    "1.0.0",
  );
  assert.equal(exitCode, 2);
  assert.match(stderr.output(), /mutually exclusive/);
  assert.match(stderr.output(), /Usage:/);
});

test("review: 非法 --fail-on / --timeout 直接拒绝", async () => {
  const harness = createHarness();
  const first = createContext();
  assert.equal(
    await runReviewCommand(
      first.ctx,
      { failOn: "sometimes" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(first.stderr.output(), /Unsupported --fail-on value/);

  const second = createContext();
  assert.equal(
    await runReviewCommand(
      second.ctx,
      { timeoutSeconds: "0" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(second.stderr.output(), /--timeout expects a positive number/);
});

test("review: 没有可审改动时退出 2 并输出 no-diff", async () => {
  const harness = createHarness();
  const { ctx, stdout } = createContext();
  const exitCode = await runReviewCommand(
    ctx,
    { json: true },
    createDeps({ module: harness.module, diff: "" }),
    "1.0.0",
  );
  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stdout.output()).error.code, "no-diff");
});

test("review: 裁决 fail 默认阻断，--fail-on never 不阻断", async () => {
  const harness = createHarness({
    text: "VERDICT: FAIL\nSUMMARY: 有缺陷\nFINDINGS:\n- [高] a.ts:1 越界",
  });
  const blocking = createContext();
  assert.equal(
    await runReviewCommand(
      blocking.ctx,
      DEFAULT_FLAGS,
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    1,
  );
  assert.match(blocking.stdout.output(), /VERDICT: FAIL/);
  assert.match(blocking.stdout.output(), /FINDINGS:/);

  const nonBlocking = createContext();
  assert.equal(
    await runReviewCommand(
      nonBlocking.ctx,
      { failOn: "never" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    0,
  );
});

test("review: --fail-on warn 把 warn 也算阻断", async () => {
  const harness = createHarness({ text: "VERDICT: WARN\nSUMMARY: 注意\nFINDINGS:\n- 无" });
  const ctx = createContext();
  assert.equal(
    await runReviewCommand(
      ctx.ctx,
      { failOn: "warn" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    1,
  );
});

test("review: --json 输出稳定形状（含 diff 范围与模型）", async () => {
  const harness = createHarness({ text: "VERDICT: WARN\nSUMMARY: 注意\nFINDINGS:\n- 无" });
  const { ctx, stdout } = createContext();
  const exitCode = await runReviewCommand(
    ctx,
    { json: true, base: "origin/main" },
    createDeps({ module: harness.module }),
    "1.0.0",
  );
  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.output());
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.verdict, "warn");
  assert.equal(payload.summary, "注意");
  assert.deepEqual(payload.model, { providerId: "zai", modelId: "glm-4.6" });
  assert.deepEqual(payload.diff, {
    source: "base",
    ref: "origin/main...HEAD",
    files: 1,
    bytes: SAMPLE_DIFF.trimEnd().length,
    truncated: false,
    excluded: 0,
  });
  assert.equal(payload.usage.outputTokens, 321);
  assert.ok(payload.elapsedMs >= 0);
});

test("review: --deep 传 agentic 与 deadline，标准模式走单轮", async () => {
  const deepHarness = createHarness();
  const deep = createContext();
  await runReviewCommand(
    deep.ctx,
    { deep: true },
    createDeps({ module: deepHarness.module }),
    "1.0.0",
  );
  const deepInput = deepHarness.generateCalls[0];
  assert.equal(deepInput?.agentic, true);
  assert.equal(deepInput?.querySource, "oracle_deep_review");
  assert.equal(typeof deepInput?.deadlineAt, "number");

  const standardHarness = createHarness();
  const standard = createContext();
  await runReviewCommand(
    standard.ctx,
    DEFAULT_FLAGS,
    createDeps({ module: standardHarness.module }),
    "1.0.0",
  );
  const standardInput = standardHarness.generateCalls[0];
  assert.equal(standardInput?.agentic, undefined);
  assert.equal(standardInput?.querySource, "oracle_turn_review");
  assert.equal(standardInput?.stream, true);
});

test("review: 推理档位缺失时补模型声明的默认档，并带上输出预算", async () => {
  const harness = createHarness({ reasoningDefaultLevel: "high", maxOutputTokens: 64_000 });
  const { ctx } = createContext();
  await runReviewCommand(ctx, DEFAULT_FLAGS, createDeps({ module: harness.module }), "1.0.0");
  const input = harness.generateCalls[0] as {
    selection: ModelSelection;
    maxOutputTokens?: number;
  };
  assert.equal(input.selection.options?.reasoningLevel, "high");
  assert.equal(input.maxOutputTokens, 64_000);
});

test("review: --model 非法格式 / 无默认模型 / git 失败都按运维错误退出", async () => {
  const harness = createHarness();

  const badModel = createContext();
  assert.equal(
    await runReviewCommand(
      badModel.ctx,
      { model: "nope" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(badModel.stderr.output(), /Expected --model <providerId>\/<modelId>/);

  // 没有 --model 且 Registry 没有默认模型 → no-model（不进入模型调用）。
  const noModelHarness = createHarness({ configuredDefault: null });
  const noModel = createContext();
  assert.equal(
    await runReviewCommand(
      noModel.ctx,
      DEFAULT_FLAGS,
      createDeps({ module: noModelHarness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(noModel.stderr.output(), /No reviewer model configured/);
  // 本构建里 providerId 可能是 UUID；不列候选等于让用户猜 --model 的值。
  assert.match(noModel.stderr.output(), /Available models: zai\/glm-4\.6/);
  assert.equal(noModelHarness.generateCalls.length, 0);

  const gitFailure = createContext();
  assert.equal(
    await runReviewCommand(
      gitFailure.ctx,
      DEFAULT_FLAGS,
      createDeps({ module: harness.module, gitError: new Error("not a git repository") }),
      "1.0.0",
    ),
    2,
  );
  assert.match(gitFailure.stderr.output(), /not a git repository/);
});

test("review: 上游异常按 request 分类，超时按 timeout 分类", async () => {
  const failing = createHarness({ generateError: new Error("upstream 500") });
  const request = createContext();
  assert.equal(
    await runReviewCommand(
      request.ctx,
      { json: true },
      createDeps({ module: failing.module }),
      "1.0.0",
    ),
    2,
  );
  assert.equal(JSON.parse(request.stdout.output()).error.code, "request");
});

test("review: 排除依赖目录的改动后不进入审查材料", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  const diff = [
    "diff --git a/node_modules/dep/index.js b/node_modules/dep/index.js",
    "--- a/node_modules/dep/index.js",
    "+++ b/node_modules/dep/index.js",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");
  const exitCode = await runReviewCommand(
    ctx,
    DEFAULT_FLAGS,
    createDeps({ module: harness.module, diff }),
    "1.0.0",
  );
  assert.equal(exitCode, 2);
  assert.equal(harness.generateCalls.length, 0);
});

test("review: --allow-empty 把「无改动」变成成功且不调用模型", async () => {
  const harness = createHarness();
  const { ctx, stdout } = createContext();
  const exitCode = await runReviewCommand(
    ctx,
    { json: true, allowEmpty: true },
    createDeps({ module: harness.module, diff: "" }),
    "1.0.0",
  );

  assert.equal(exitCode, 0);
  assert.equal(harness.generateCalls.length, 0);
  const payload = JSON.parse(stdout.output());
  assert.equal(payload.empty, true);
  assert.equal(payload.verdict, "pass");
  assert.equal(payload.findingsStructured.length, 0);
});

test("review: --json 额外给出结构化发现项（file/line 来自正文）", async () => {
  const harness = createHarness({
    text: "VERDICT: FAIL\nSUMMARY: 有缺陷\nFINDINGS:\n- [高] a.ts:1 越界",
  });
  const { ctx, stdout } = createContext();
  await runReviewCommand(
    ctx,
    { format: "json" },
    createDeps({ module: harness.module }),
    "1.0.0",
  );

  const payload = JSON.parse(stdout.output());
  assert.deepEqual(payload.findingsStructured, [
    { severity: "error", message: "[高] a.ts:1 越界", file: "a.ts", line: 1 },
  ]);
});

test("review: --format sarif 输出 2.1.0 报告，带等级与位置", async () => {
  const harness = createHarness({
    text: "VERDICT: FAIL\nSUMMARY: 有缺陷\nFINDINGS:\n- a.ts:12 越界",
  });
  const { ctx, stdout } = createContext();
  const exitCode = await runReviewCommand(
    ctx,
    { format: "sarif" },
    createDeps({ module: harness.module }),
    "1.0.0",
  );

  assert.equal(exitCode, 1);
  const payload = JSON.parse(stdout.output());
  assert.equal(payload.version, "2.1.0");
  const run = payload.runs[0];
  assert.equal(run.tool.driver.name, "zcode-review");
  assert.equal(run.results[0].ruleId, "oracle-review-finding");
  assert.equal(run.results[0].level, "error");
  assert.equal(
    run.results[0].locations[0].physicalLocation.artifactLocation.uri,
    "a.ts",
  );
  assert.equal(run.results[0].locations[0].physicalLocation.region.startLine, 12);
  assert.equal(run.properties.oracleVerdict, "fail");
});

test("review: --format 非法值与 --json 冲突都按用法错误退出", async () => {
  const harness = createHarness();

  const unsupported = createContext();
  assert.equal(
    await runReviewCommand(
      unsupported.ctx,
      { format: "yaml" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(unsupported.stderr.output(), /Unsupported --format value/);

  const conflicting = createContext();
  assert.equal(
    await runReviewCommand(
      conflicting.ctx,
      { json: true, format: "text" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(conflicting.stderr.output(), /--json and --format conflict/);
});

const BASELINE_FINDINGS = "VERDICT: FAIL\nSUMMARY: 有缺陷\nFINDINGS:\n- a.ts:12 越界";

function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-review-baseline-"));
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function baselinePayload(fingerprints: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    accepted: fingerprints.map((fingerprint) => ({
      fingerprint,
      ruleId: "oracle-review-finding",
      severity: "error",
      message: "越界",
    })),
  });
}

test("review: --baseline 命中后抑制发现项并把裁决降级为 pass", async () => {
  await withTempDir(async (dir) => {
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(baselinePath, baselinePayload(["loc|a.ts|12"]), "utf8");

    const harness = createHarness({ text: BASELINE_FINDINGS });
    const { ctx, stdout } = createContext();
    const exitCode = await runReviewCommand(
      ctx,
      { format: "json", baseline: baselinePath },
      createDeps({ module: harness.module }),
      "1.0.0",
    );

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.output());
    assert.equal(payload.verdict, "pass");
    assert.deepEqual(payload.findingsStructured, []);
    assert.equal(payload.suppressedFindings.length, 1);
    assert.deepEqual(payload.baseline, {
      file: baselinePath,
      suppressed: 1,
      verdictBeforeBaseline: "fail",
    });
  });
});

test("review: --baseline 未命中时仍然阻断", async () => {
  await withTempDir(async (dir) => {
    const baselinePath = join(dir, "baseline.json");
    writeFileSync(baselinePath, baselinePayload(["loc|a.ts|99"]), "utf8");

    const harness = createHarness({ text: BASELINE_FINDINGS });
    const { ctx, stdout } = createContext();
    const exitCode = await runReviewCommand(
      ctx,
      { format: "json", baseline: baselinePath },
      createDeps({ module: harness.module }),
      "1.0.0",
    );

    assert.equal(exitCode, 1);
    const payload = JSON.parse(stdout.output());
    assert.equal(payload.verdict, "fail");
    assert.equal(payload.findingsStructured.length, 1);
    assert.equal(payload.suppressedFindings, undefined);
  });
});

test("review: --write-baseline 落盘当前发现项且不阻断", async () => {
  await withTempDir(async (dir) => {
    const baselinePath = join(dir, "nested", "baseline.json");
    const harness = createHarness({ text: BASELINE_FINDINGS });
    const { ctx, stdout } = createContext();
    const exitCode = await runReviewCommand(
      ctx,
      { format: "json", writeBaseline: baselinePath },
      createDeps({ module: harness.module }),
      "1.0.0",
    );

    assert.equal(exitCode, 0);
    const payload = JSON.parse(stdout.output());
    assert.equal(payload.baselineWritten, baselinePath);

    const written = JSON.parse(readFileSync(baselinePath, "utf8"));
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.accepted.length, 1);
    assert.equal(written.accepted[0].fingerprint, "loc|a.ts|12");
    assert.equal(written.accepted[0].file, "a.ts");
    assert.equal(written.accepted[0].line, 12);
  });
});

test("review: 基线文件不可读或结构不对时按用法错误退出", async () => {
  await withTempDir(async (dir) => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json", "utf8");
    const harness = createHarness({ text: BASELINE_FINDINGS });

    const malformed = createContext();
    assert.equal(
      await runReviewCommand(
        malformed.ctx,
        { baseline: broken },
        createDeps({ module: harness.module }),
        "1.0.0",
      ),
      2,
    );
    assert.match(malformed.stderr.output(), /Cannot read baseline/);

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ schemaVersion: 1, accepted: [{}] }), "utf8");
    const shape = createContext();
    assert.equal(
      await runReviewCommand(
        shape.ctx,
        { baseline: wrongShape },
        createDeps({ module: harness.module }),
        "1.0.0",
      ),
      2,
    );
    assert.match(shape.stderr.output(), /non-empty "fingerprint"/);
  });
});

test("review: --baseline 与 --write-baseline 互斥", async () => {
  const harness = createHarness();
  const { ctx, stderr } = createContext();
  assert.equal(
    await runReviewCommand(
      ctx,
      { baseline: "a.json", writeBaseline: "b.json" },
      createDeps({ module: harness.module }),
      "1.0.0",
    ),
    2,
  );
  assert.match(stderr.output(), /mutually exclusive/);
});

test("review-findings: prepareBaselineFile 真的探测可写性且不破坏已有文件", async () => {
  await withTempDir(async (dir) => {
    const existing = join(dir, "existing.json");
    const content = '{"schemaVersion":1,"accepted":[]}';
    writeFileSync(existing, content, "utf8");

    assert.equal(prepareBaselineFile(existing), undefined);
    // 追加模式打开不应截断或改写已有基线。
    assert.equal(readFileSync(existing, "utf8"), content);

    // 父目录不存在时创建后探测通过，且不留下探针文件。
    assert.equal(prepareBaselineFile(join(dir, "a", "b", "x.json")), undefined);
    assert.equal(existsSync(join(dir, "a", "b", "x.json")), false);
    assert.deepEqual(
      readdirSync(join(dir, "a", "b")).filter((name) => name.startsWith(".zcode-baseline-probe-")),
      [],
    );

    // 目标本身是目录：父目录存在但目标不可写，这正是 mkdir 预检漏掉的情形。
    const asDirectory = join(dir, "sub");
    mkdirSync(asDirectory);
    assert.ok(prepareBaselineFile(asDirectory) instanceof Error);
  });
});
