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

  it("地图位置解析：Windows 盘符路径不被截断（B1-05）", () => {
    // 缺陷：FINDING_LOCATION_PATTERN 的字符类不含 `:`，`C:\repo\src\a.ts:12` 会从
    // 第一个冒号之后重新起算，产出 file="eposrca.ts" —— 指错文件比不指更糟。
    const [finding] = parseStructuredFindings("- [高] C:\\repo\\src\\a.ts:12 越界", "fail");
    expect(finding?.file).toBe("C:\\repo\\src\\a.ts");
    expect(finding?.line).toBe(12);
  });

  it("位置解析：含空格的文件名保留完整路径（B1-05）", () => {
    // 缺陷：字符类不含空格，"my file.ts:12" 只截到 "file.ts"，丢了目录/前缀。
    const [finding] = parseStructuredFindings("- [高] my file.ts:12 越界", "fail");
    expect(finding?.file).toBe("my file.ts");
    expect(finding?.line).toBe(12);
  });

  it("位置解析：无扩展名文件与脚本也能识别（B1-05）", () => {
    // Makefile / scripts/build 这类没有扩展名的常见目标原来完全不解析位置。
    const findings = parseStructuredFindings(
      "- [高] Makefile:12 缺 .PHONY\n- [高] scripts/build:5 未加 set -e",
      "fail",
    );
    expect(findings[0]?.file).toBe("Makefile");
    expect(findings[0]?.line).toBe(12);
    expect(findings[1]?.file).toBe("scripts/build");
    expect(findings[1]?.line).toBe(5);
  });

  it("位置解析：行范围取起始行", () => {
    const [finding] = parseStructuredFindings("- [高] src/a.ts:12-18 越界", "fail");
    expect(finding?.file).toBe("src/a.ts");
    expect(finding?.line).toBe(12);
  });

  it("位置解析：识别不到位置时退化为无位置，不编造", () => {
    // 关键取舍：宁可没有位置（fingerprint 走 msg|），也不能给出错误路径。
    for (const line of [
      "- [高] 这个函数缺少边界校验",
      "- [高] 第 12 行有问题",
      "- [高] 见上文说明",
    ]) {
      const [finding] = parseStructuredFindings(line, "fail");
      expect(finding?.file, line).toBeUndefined();
      expect(finding?.line, line).toBeUndefined();
    }
  });

  it("地图位置解析：普通散文里的冒号数字不当位置", () => {
    // 避免把「错误码: 500」这类文本误判成 file:line。
    const [finding] = parseStructuredFindings("- [中] 返回 HTTP 状态 200: 但语义错误", "warn");
    expect(finding?.file).toBeUndefined();
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
