// ============================================================
// Minimal Guardrails Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * 极简模式唯一的内容段（除身份行与环境外）。
 *
 * 该模式的定义是「提示词只留系统工具」，但它同时是自动执行权限——不加这一段，
 * 模型手里就一条防线都没有。这里刻意压到三条、每条一句话：护栏的价值在「永远在场」，
 * 不在详尽；写得越长就越背离极简模式本身。
 */
const MINIMAL_GUARDRAILS_CONTENT = [
  "# Guardrails",
  "",
  "You run with automatic permissions and no other instructions beyond this prompt.",
  "- Destructive or hard-to-reverse actions (deleting files or data, `git reset --hard`, force push, dropping schemas or migrations, touching production systems or credentials) require the user's explicit confirmation first.",
  "- Never claim success you have not verified; report failures as failures.",
  "- Change only what the current task requires.",
].join("\n");

export function buildMinimalGuardrailsSection(): ContextSection {
  return {
    name: "Minimal Guardrails",
    source: "minimal_guardrails",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: MINIMAL_GUARDRAILS_CONTENT.length,
    tokens: estimateTokens(MINIMAL_GUARDRAILS_CONTENT),
    content: MINIMAL_GUARDRAILS_CONTENT,
    preview: MINIMAL_GUARDRAILS_CONTENT.slice(0, 100),
  };
}
