import { describe, expect, it } from "vitest";
import {
  buildOracleReviewPrompt,
  isOracleDiffExcludedPath,
  isOracleFindingsEmpty,
  parseOracleVerdict,
  splitUnifiedDiffIntoOracleSections,
} from "../src/oracle-review/index.js";

const SAMPLE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  "diff --git a/node_modules/dep/index.js b/node_modules/dep/index.js",
  "index 3333333..4444444 100644",
  "--- a/node_modules/dep/index.js",
  "+++ b/node_modules/dep/index.js",
  "@@ -1 +1 @@",
  "-module.exports = 1;",
  "+module.exports = 2;",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/readme.md",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

describe("splitUnifiedDiffIntoOracleSections", () => {
  it("按文件切段并跳过排除路径", () => {
    const result = splitUnifiedDiffIntoOracleSections(SAMPLE_DIFF);

    expect(result.sections.map((section) => section.path)).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(result.sections[0]?.text).toContain("-const a = 1;");
    expect(result.sections[0]?.text).toContain("+const a = 2;");
    expect(result.fileCount).toBe(2);
    expect(result.excluded).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("空 diff 返回空结果", () => {
    expect(splitUnifiedDiffIntoOracleSections("")).toEqual({
      sections: [],
      fileCount: 0,
      bytes: 0,
      truncated: false,
      excluded: 0,
    });
  });

  it("超过文件数上限时标记裁剪", () => {
    const result = splitUnifiedDiffIntoOracleSections(SAMPLE_DIFF, { maxFiles: 1 });
    expect(result.sections).toHaveLength(1);
    expect(result.fileCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("超过体积上限时保留首个文件并标记裁剪", () => {
    const result = splitUnifiedDiffIntoOracleSections(SAMPLE_DIFF, { maxBytes: 10 });
    // 第一个文件即使超预算也要纳入，否则「一个大文件」会被报告成「没有可审的改动」。
    expect(result.sections).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("兼容 CRLF 与带引号的路径", () => {
    const diff = [
      'diff --git "a/中文 文件.ts" "b/中文 文件.ts"',
      "--- /dev/null",
      "+++ b/中文 文件.ts",
      "@@ -0,0 +1 @@",
      "+x",
    ].join("\r\n");

    const result = splitUnifiedDiffIntoOracleSections(diff);
    expect(result.sections.map((section) => section.path)).toEqual(["中文 文件.ts"]);
    expect(result.sections[0]?.text).toContain("+x");
    expect(result.sections[0]?.text).not.toContain("\r");
  });
});

describe("isOracleDiffExcludedPath", () => {
  it("排除依赖/构建/内部目录与目录条目", () => {
    expect(isOracleDiffExcludedPath("node_modules/a/index.js")).toBe(true);
    expect(isOracleDiffExcludedPath("packages/ui/dist/x.js")).toBe(true);
    expect(isOracleDiffExcludedPath("src/")).toBe(true);
    expect(isOracleDiffExcludedPath("src\\ui\\App.tsx")).toBe(false);
  });
});

describe("buildOracleReviewPrompt", () => {
  const baseParams = {
    diffSections: [{ path: "src/a.ts", text: "--- a/src/a.ts\n+++ b/src/a.ts" }],
    completenessNotes: [],
    depth: "standard" as const,
  };

  it("turn 模式（默认）保持原样：回合材料为主，diff 只作辅助证据", () => {
    const prompt = buildOracleReviewPrompt({
      ...baseParams,
      targetMaterialText: "### 目标回合\n用户：改一下",
    });

    expect(prompt).toContain(
      "你是独立对话质量审查者（Oracle）。请核查一位编程智能体对用户请求的回应是否正确、完整、合规。",
    );
    expect(prompt).toContain("审查模式：标准审查（单轮对话核查）");
    expect(prompt).toContain("## 审查材料\n### 目标回合\n用户：改一下");
    expect(prompt).toContain("## 辅助证据：回合文件改动（unified diff）");
    expect(prompt).not.toContain("待审查的改动");
  });

  it("diff 模式把改动本身当材料，不渲染空的回合材料段", () => {
    const prompt = buildOracleReviewPrompt({
      ...baseParams,
      materialKind: "diff",
    });

    expect(prompt).toContain("你是独立代码审查者（Oracle）。");
    expect(prompt).toContain("审查模式：标准审查（改动核查）");
    expect(prompt).toContain("## 审查材料：待审查的改动（unified diff）");
    expect(prompt).toContain("审查对象就是这批改动本身");
    expect(prompt).not.toContain("## 审查材料\n");
    expect(prompt).not.toContain("## 辅助证据");
    // 输出格式仍与对话审查一致，CLI 才能复用同一套 verdict 解析。
    expect(prompt).toContain("第一行：VERDICT: PASS|WARN|FAIL|INSUFFICIENT");
  });

  it("diff 模式的深度审查换成改动核查的取证指引", () => {
    const prompt = buildOracleReviewPrompt({
      ...baseParams,
      materialKind: "diff",
      depth: "deep",
    });

    expect(prompt).toContain("审查模式：深度审查（改动核查 + 只读取证）");
    expect(prompt).toContain("你审查的是一批待合入的改动");
    expect(prompt).toContain("不要修改任何代码、不要执行任何写操作");
  });
});

describe("parseOracleVerdict", () => {
  it("五态解析与降级", () => {
    expect(parseOracleVerdict("VERDICT: PASS\nSUMMARY: ok").verdict).toBe("pass");
    expect(parseOracleVerdict("VERDICT: WARN\nSUMMARY: 注意").verdict).toBe("warn");
    expect(parseOracleVerdict("VERDICT: FAIL\nSUMMARY: 有问题").verdict).toBe("fail");
    expect(parseOracleVerdict("VERDICT: INSUFFICIENT\nSUMMARY: 材料不足").verdict).toBe(
      "insufficient",
    );
    const unknown = parseOracleVerdict("看不出结论");
    expect(unknown.verdict).toBe("unknown");
    expect(unknown.findings).toBe("看不出结论");
  });

  it("解析 SCOPE / LIMITS 段", () => {
    const parsed = parseOracleVerdict(
      [
        "VERDICT: FAIL",
        "SUMMARY: 有缺陷",
        "FINDINGS:",
        "- [高] a.ts:1 越界",
        "SCOPE: 工作区改动",
        "LIMITS: 未跑测试",
      ].join("\n"),
    );
    expect(parsed.findings).toContain("[高] a.ts:1 越界");
    expect(parsed.scope).toBe("工作区改动");
    expect(parsed.limits).toBe("未跑测试");
  });
});

describe("isOracleFindingsEmpty", () => {
  it("空文本与常见空语义占位词判空（含包装标点/全角/大小写变体）", () => {
    for (const text of [
      "",
      "   ",
      "无",
      "无。",
      "（无）",
      "【无】",
      "「无」",
      "无问题清单",
      "(no issues)",
      "None",
      "N/A",
      "  n/a  ",
      "没有问题",
      "无\u3000",
    ]) {
      expect(isOracleFindingsEmpty(text), JSON.stringify(text)).toBe(true);
    }
  });

  it("任何真实问题文本都不判空（宁可多给移交入口，也不吞掉问题）", () => {
    for (const text of [
      "- [高] a.ts:1 越界",
      "无问题清单，但建议补测试",
      "没有明显问题，只有命名风格小节",
      "none of the requirements are covered",
      "（无）但 [[中]] b.ts 未处理异常",
      "1",
    ]) {
      expect(isOracleFindingsEmpty(text), JSON.stringify(text)).toBe(false);
    }
  });
});
