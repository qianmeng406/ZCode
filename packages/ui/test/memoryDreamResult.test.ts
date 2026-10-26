import { describe, expect, it } from "vitest";
import type { ZCodeSessionRunMemoryDreamResult } from "@zcode/shared";

import { formatMemoryDreamResult } from "@/v4/memory/memoryDreamResult.js";

// 文案映射用 stub intl：只断言「选了哪个 key / 传了哪些参数」，
// 真实中文/英文文案由 locale 文件负责。
const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>): string =>
    values ? `${id}:${JSON.stringify(values)}` : id,
} as never;

function result(
  overrides: Partial<ZCodeSessionRunMemoryDreamResult> = {},
): ZCodeSessionRunMemoryDreamResult {
  return { status: "completed", touchedPaths: [], changes: [], ...overrides };
}

describe("formatMemoryDreamResult", () => {
  it("summarises file count and line deltas on completion", () => {
    expect(
      formatMemoryDreamResult(
        intl,
        result({
          touchedPaths: ["/m/a.md", "/m/b.md"],
          changes: [
            { path: "/m/a.md", addedLines: 3, removedLines: 1 },
            { path: "/m/b.md", addedLines: 2, removedLines: 0 },
          ],
        }),
      ),
    ).toBe('chat.memoryDream.completed:{"files":2,"added":5,"removed":1}');
  });

  it("reports an up-to-date memory directory without touching numbers", () => {
    expect(formatMemoryDreamResult(intl, result({ touchedPaths: ["/m/a.md"] }))).toBe(
      "chat.memoryDream.completedNoChanges",
    );
  });

  it("maps skip reasons to distinct copy", () => {
    expect(formatMemoryDreamResult(intl, result({ status: "skipped" }))).toBe(
      "chat.memoryDream.skipped",
    );
    expect(formatMemoryDreamResult(intl, result({ status: "skipped", reason: "not_due" }))).toBe(
      "chat.memoryDream.skippedNotDue",
    );
    expect(
      formatMemoryDreamResult(
        intl,
        result({ status: "skipped", reason: "insufficient_transcripts" }),
      ),
    ).toBe("chat.memoryDream.skippedNoTranscripts");
  });

  it("maps lock / extraction / disabled reasons instead of leaking machine codes", () => {
    expect(formatMemoryDreamResult(intl, result({ status: "already_running" }))).toBe(
      "chat.memoryDream.alreadyRunning",
    );
    expect(formatMemoryDreamResult(intl, result({ status: "busy" }))).toBe("chat.memoryDream.busy");
    expect(formatMemoryDreamResult(intl, result({ status: "disabled" }))).toBe(
      "chat.memoryDream.disabled",
    );
    expect(
      formatMemoryDreamResult(intl, result({ status: "disabled", reason: "memory_disabled" })),
    ).toBe("chat.memoryDream.disabledMemory");
    expect(
      formatMemoryDreamResult(intl, result({ status: "disabled", reason: "remote_workspace" })),
    ).toBe("chat.memoryDream.disabledRemote");
    expect(
      formatMemoryDreamResult(
        intl,
        result({ status: "disabled", reason: "fork_feature_disabled" }),
      ),
    ).toBe("chat.memoryDream.disabledFeature");
  });

  it("keeps a truncated failure reason and falls back to the plain failure copy", () => {
    expect(formatMemoryDreamResult(intl, result({ status: "failed" }))).toBe(
      "chat.memoryDream.failed",
    );
    expect(formatMemoryDreamResult(intl, result({ status: "failed", reason: "disk full" }))).toBe(
      'chat.memoryDream.failedWithReason:{"reason":"disk full"}',
    );
    const longReason = "x".repeat(500);
    const message = formatMemoryDreamResult(intl, result({ status: "failed", reason: longReason }));
    expect(message).toContain(`"reason":"${"x".repeat(160)}"`);
    expect(message).not.toContain("x".repeat(161));
  });
});
