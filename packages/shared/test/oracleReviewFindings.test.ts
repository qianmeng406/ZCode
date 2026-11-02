import { describe, expect, it } from "vitest";
import {
  findingFingerprint,
  parseOracleVerdict,
  parseStructuredFindings,
  severityForVerdict,
  type StructuredFinding,
} from "@zcode/shared/oracle-review";

describe("oracle review structured findings", () => {
  it("maps the prompt's Chinese severity labels", () => {
    const findings = parseStructuredFindings(
      ["- [高] src/a.ts:12 — 空指针", "- [中] src/b.ts:3 — 缺少校验", "- [低] 命名不一致"].join(
        "\n",
      ),
      "warn",
    );
    expect(findings.map((item) => item.severity)).toEqual(["error", "warning", "note"]);
    expect(findings[0]).toMatchObject({ file: "src/a.ts", line: 12 });
    expect(findings[2]).not.toHaveProperty("file");
  });

  it("falls back to the verdict severity when no label is present", () => {
    expect(parseStructuredFindings("no label here", "fail")[0]?.severity).toBe("error");
    expect(parseStructuredFindings("no label here", "warn")[0]?.severity).toBe("warning");
    expect(parseStructuredFindings("no label here", "pass")[0]?.severity).toBe("note");
  });

  it("skips section-marker and no-findings lines instead of turning them into items", () => {
    // 线上事故（2026-11-02）：审查队列 75 条待审里只有 1 条真问题，
    // 其余都是 FINDINGS:/VERDICT: FAIL/SUMMARY: 这类段落标题行。
    const raw = [
      "VERDICT: FAIL",
      "SUMMARY: 聚合口径方向正确，但取消了下限。",
      "FINDINGS:",
      "- [高] packages/ui/src/a.tsx:155 — 聚合速度缺少 500ms 下限",
      "REQUIREMENTS:",
      "- 窗口 <500ms 不出速度 — 部分落实",
      "SCOPE: 覆盖四轮",
      "LIMITS: 沙箱拒绝部分命令",
      "无",
      "None",
    ].join("\n");
    // 走真实管线：先切段再结构化，REQUIREMENTS 段不会被算成发现项。
    const parsed = parseOracleVerdict(raw);
    const findings = parseStructuredFindings(parsed.findings, parsed.verdict);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "error",
      file: "packages/ui/src/a.tsx",
      line: 155,
    });
    // 单独喂标题行时也不能成条（模型格式更乱、没走切段的情况）。
    expect(
      parseStructuredFindings(
        ["VERDICT: FAIL", "FINDINGS:", "REQUIREMENTS:", "SCOPE: 四轮", "无", "None"].join("\n"),
        "fail",
      ),
    ).toEqual([]);
  });

  it("strips list markers and numbered bullets", () => {
    const findings = parseStructuredFindings("- [high] a.ts:1 — x\n1. [low] b.ts:2 — y", "fail");
    expect(findings.map((item) => item.message)).toEqual(["[high] a.ts:1 — x", "[low] b.ts:2 — y"]);
  });

  it("keeps fingerprints stable across separators, dot prefix, case and whitespace", () => {
    const base: StructuredFinding = {
      severity: "error",
      message: "Null  Check",
      file: "src\\a.ts",
      line: 9,
    };
    expect(findingFingerprint(base)).toBe("loc|src/a.ts|9");
    expect(findingFingerprint({ ...base, file: "./src/a.ts" })).toBe("loc|src/a.ts|9");
    expect(
      findingFingerprint({ severity: "warning", message: "Null  check", file: "src/a.ts" }),
    ).toBe("file|src/a.ts|null check");
    expect(findingFingerprint({ severity: "note", message: "  Same   text " })).toBe(
      "msg|same text",
    );
  });

  it("maps verdicts to SARIF-compatible severities", () => {
    expect(severityForVerdict("fail")).toBe("error");
    expect(severityForVerdict("warn")).toBe("warning");
    expect(severityForVerdict("pass")).toBe("note");
    expect(severityForVerdict("insufficient")).toBe("note");
  });
});
