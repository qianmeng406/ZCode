// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  MEMORY_CAPTURE_MAX_BODY_CHARS,
  MEMORY_CAPTURE_MAX_INPUT_CHARS,
  appendMemoryIndexLine,
  buildMemoryCaptureMessages,
  buildMemoryIndexLine,
  formatMemoryCaptureFile,
  memoryCaptureFileName,
  parseMemoryCaptureResult,
  truncateMemoryCaptureInput,
} from "@/v4/memory/memoryCapturePrompt.js";

describe("memory capture prompt", () => {
  it("输入超长时保留尾部（结论通常在后半段）", () => {
    const longText = `${"a".repeat(MEMORY_CAPTURE_MAX_INPUT_CHARS)}TAIL`;
    const truncated = truncateMemoryCaptureInput(longText);
    expect(truncated.length).toBe(MEMORY_CAPTURE_MAX_INPUT_CHARS + 1);
    expect(truncated.endsWith("TAIL")).toBe(true);
    expect(truncated.startsWith("…")).toBe(true);
  });

  it("消息里同时带项目名与有界片段", () => {
    const messages = buildMemoryCaptureMessages({
      assistantText: "  done: use pnpm  ",
      projectName: "z-code",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain('"type": "project" | "user" | "feedback" | "reference"');
    expect(messages[1]?.content).toContain("Project: z-code");
    expect(messages[1]?.content).toContain("done: use pnpm");
  });
});

describe("parseMemoryCaptureResult", () => {
  it("解析裸 JSON 并裁剪到上限", () => {
    const parsed = parseMemoryCaptureResult(
      JSON.stringify({
        name: "n".repeat(120),
        description: "d".repeat(400),
        type: "feedback",
        body: "b".repeat(MEMORY_CAPTURE_MAX_BODY_CHARS + 50),
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.name).toHaveLength(60);
    expect(parsed.draft.description).toHaveLength(140);
    expect(parsed.draft.body).toHaveLength(MEMORY_CAPTURE_MAX_BODY_CHARS);
    expect(parsed.draft.type).toBe("feedback");
  });

  it("容忍代码围栏与前后说明", () => {
    const parsed = parseMemoryCaptureResult(
      'Sure, here it is:\n```json\n{"name":"Repo rules","description":"Use pnpm","type":"project","body":"Run pnpm -w test."}\n```\nDone.',
    );
    expect(parsed).toMatchObject({
      ok: true,
      draft: { name: "Repo rules", description: "Use pnpm", type: "project" },
    });
  });

  it.each([
    ["没有 JSON", "not json at all", "no-json"],
    ["JSON 非法", '{"name": "x",}', "invalid-json"],
    ["空条目", '{"name":"","body":""}', "empty"],
    ["类型不合法", '{"name":"x","body":"y","type":"misc"}', "invalid-type"],
  ])("%s 时给出稳定失败原因（%s）", (_label, text, reason) => {
    expect(parseMemoryCaptureResult(text)).toEqual({ ok: false, reason });
  });
});

describe("memory capture file shape", () => {
  it("文件名归一成 ASCII slug", () => {
    expect(memoryCaptureFileName("Use pnpm workspace!")).toBe("use-pnpm-workspace.md");
    expect(memoryCaptureFileName("   ")).toBe("memory-note.md");
    expect(memoryCaptureFileName("名字")).toBe("memory-note.md");
  });

  it("frontmatter 与 Memory Agent 生成的文件同形，并转义引号与换行", () => {
    const content = formatMemoryCaptureFile(
      {
        name: "Repo rules",
        description: 'Use "pnpm"\nworkspace',
        type: "project",
        body: "Run pnpm -w test.",
      },
      "repo-rules.md",
    );
    expect(content).toBe(
      [
        "---",
        'name: "repo-rules"',
        'description: "Use \\"pnpm\\" workspace"',
        "metadata:",
        "  node_type: memory",
        "  type: project",
        "---",
        "",
        "Run pnpm -w test.",
        "",
      ].join("\n"),
    );
  });
});

describe("memory index line", () => {
  it("新建索引时带一级标题", () => {
    const line = buildMemoryIndexLine({
      fileName: "repo-rules.md",
      title: "Repo rules",
      description: "Use pnpm",
    });
    expect(line).toBe("- [Repo rules](repo-rules.md) — Use pnpm");
    expect(appendMemoryIndexLine(null, line)).toBe(`# Memory\n\n${line}\n`);
  });

  it("追加到既有索引末尾，保留原有内容并统一结尾换行", () => {
    const line = "- [New](new.md)";
    expect(appendMemoryIndexLine("# Memory\n\n- [Old](old.md)", line)).toBe(
      "# Memory\n\n- [Old](old.md)\n- [New](new.md)\n",
    );
    expect(appendMemoryIndexLine("# Memory\n- [Old](old.md)\n\n", line)).toBe(
      "# Memory\n- [Old](old.md)\n- [New](new.md)\n",
    );
  });

  it("同一文件已有链接时不重复追加", () => {
    const index = "# Memory\n\n- [Old](old.md) — x\n";
    expect(appendMemoryIndexLine(index, "- [Renamed](old.md) — y")).toBe(index);
  });

  it("标题里的方括号与换行被清洗", () => {
    expect(
      buildMemoryIndexLine({
        fileName: "x.md",
        title: "[weird]\ntitle",
        description: "",
      }),
    ).toBe("- [weird title](x.md)");
  });
});
