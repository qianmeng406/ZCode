// ============================================================
// Message Assembly - 从有序 sections 组装 system 消息与 meta_user 附件
// ============================================================

import type { ModelInputMessage } from "@zcode/contracts";
import type { ContextMetaUserAttachment, ContextSection } from "./types.js";
import {
  buildContextMetaUserBody,
  buildSkillsMetaUserBody,
  joinSectionContents,
} from "./meta-user-body.js";

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

export function orderSectionsForInjection(sections: ContextSection[]): ContextSection[] {
  return [
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "stable",
    ),
    ...sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.cacheHint === "dynamic",
    ),
  ];
}

export function assembleSystemMessages(sections: ContextSection[]): ModelInputMessage[] {
  const messages: ModelInputMessage[] = [];

  const cliPrefixContent = joinSectionContents(
    sections.filter(
      (section) => section.injectionTarget === "system" && section.source === "cli_prefix",
    ),
  );
  if (cliPrefixContent) {
    messages.push({
      role: "system",
      content: cliPrefixContent,
    });
  }

  const stableBodyContent = joinSectionContents(
    sections.filter(
      (section) =>
        section.injectionTarget === "system" &&
        section.cacheHint === "stable" &&
        section.source !== "cli_prefix",
    ),
  );
  if (stableBodyContent) {
    messages.push({
      role: "system",
      content: stableBodyContent,
      cacheControl: EPHEMERAL_CACHE_CONTROL,
    });
  }

  const dynamicSystemContent = joinSectionContents(
    sections.filter(
      (section) => section.injectionTarget === "system" && section.cacheHint === "dynamic",
    ),
  );
  if (dynamicSystemContent) {
    messages.push({
      role: "system",
      // ZCode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致。
      content: `\n\n${dynamicSystemContent}`,
      cacheControl: EPHEMERAL_CACHE_CONTROL,
    });
  }

  return messages;
}

export function assembleMetaUserAttachments(
  sections: ContextSection[],
): ContextMetaUserAttachment[] {
  const attachments: ContextMetaUserAttachment[] = [];

  const skillsContent = buildSkillsMetaUserBody(
    sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.source === "skills",
    ),
  );
  if (skillsContent) {
    attachments.push({
      source: "skills_listing",
      content: skillsContent,
    });
  }

  const contextContent = buildContextMetaUserBody(
    sections.filter(
      (section) => section.injectionTarget === "meta_user" && section.source !== "skills",
    ),
  );
  if (contextContent) {
    attachments.push({
      source: "context_prefix",
      content: contextContent,
    });
  }

  return attachments;
}
