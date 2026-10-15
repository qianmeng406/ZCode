// ============================================================
// Meta User Body Builders - meta_user 附件正文的组合规则
// ============================================================

import type { ContextSection } from "./types.js";

function buildSectionContent(sections: ContextSection[]): string {
  return joinSectionContents(sections);
}

/** 组合多个 section 的正文（system 消息与 meta_user body 共用）。 */
export function joinSectionContents(sections: ContextSection[]): string {
  return sections.map((section) => section.content).join("\n\n");
}

export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (sections.length === 0) return null;

  return [
    "As you answer the user's questions, you can use the following context:",
    buildSectionContent(sections),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}

export function buildSkillsMetaUserBody(sections: ContextSection[]): string | null {
  const content = buildSectionContent(sections);
  if (!content) {
    return null;
  }

  return content;
}
