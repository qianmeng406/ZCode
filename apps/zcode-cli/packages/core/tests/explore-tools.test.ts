import { describe, expect, it } from "vitest";
import {
  buildExploreAllowedTools,
  formatExploreAllowedToolsForAgentDescription,
} from "../src/subagent/explore-tools.js";

// research 模式检索渠道（fork 定制）：只读、走网络，Explore 白名单一并放行，
// 顺序与 explore-tools.ts 的 EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY 一致。
const RESEARCH_TOOLS = [
  "SearchDocs",
  "GetLibraryDocs",
  "SearchStackOverflow",
  "SearchGitHub",
  "SearchHackerNews",
  "SearchArxiv",
  "SearchNpm",
  "SearchPyPI",
  "SearchMdn",
  "SearchPapers",
  "SearchPubmed",
];

describe("Explore tool policy", () => {
  it("keeps direct and embedded-search Explore tool lists in sync with provider-visible text", () => {
    expect(buildExploreAllowedTools()).toEqual([
      "ToolSearch",
      "DeferredToolCall",
      "Bash",
      "Glob",
      "Grep",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      ...RESEARCH_TOOLS,
    ]);
    expect(formatExploreAllowedToolsForAgentDescription()).toBe(
      ["Glob", "Grep", "Read", "Bash", "WebFetch", "WebSearch", "TodoWrite", ...RESEARCH_TOOLS].join(
        ", ",
      ),
    );

    expect(buildExploreAllowedTools({ embeddedSearchEnabled: true })).toEqual([
      "ToolSearch",
      "DeferredToolCall",
      "Bash",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      ...RESEARCH_TOOLS,
    ]);
    expect(formatExploreAllowedToolsForAgentDescription({ embeddedSearchEnabled: true })).toBe(
      ["Read", "Bash", "WebFetch", "WebSearch", "TodoWrite", ...RESEARCH_TOOLS].join(", "),
    );
  });
});
