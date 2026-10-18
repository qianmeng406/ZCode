#!/usr/bin/env node
/**
 * 提交信息门禁：Conventional Commits 的轻量校验。
 *
 * 只校验首行（标题）：`type(scope): subject`，标题 ≤100 字符。
 * 放行 Merge / Revert / fixup! / squash! / amend! 这些 Git 或 rebase 生成的标题。
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "security",
];

const HEADER_RE = new RegExp(`^(${COMMIT_TYPES.join("|")})(?:\\([\\w./-]+\\))?!?: \\S.*$`, "u");
const GIT_GENERATED_RE = /^(?:Merge |Revert |fixup! |squash! |amend! )/u;
const MAX_HEADER_LENGTH = 100;

/** @returns {{ok: boolean, header: string, errors: string[]}} */
export function validateCommitMessage(message) {
  const lines = String(message ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("#"));
  const header = (lines.find((line) => line.trim().length > 0) ?? "").trim();

  if (!header) {
    return { ok: false, header, errors: ["提交信息为空。"] };
  }
  if (GIT_GENERATED_RE.test(header)) {
    return { ok: true, header, errors: [] };
  }

  const errors = [];
  if (header.length > MAX_HEADER_LENGTH) {
    errors.push(`标题 ${header.length} 字符，超过 ${MAX_HEADER_LENGTH} 字符上限。`);
  }
  if (!HEADER_RE.test(header)) {
    errors.push(
      `标题不符合 Conventional Commits：期望 \`type(scope): subject\`，type 取 ${COMMIT_TYPES.join("|")}。`,
    );
  }
  return { ok: errors.length === 0, header, errors };
}

export function formatValidationErrors(result) {
  if (result.ok) return [];
  return [
    "[git-gate:commit-msg] 提交信息未通过校验：",
    `  实际标题：${result.header || "(空)"}`,
    ...result.errors.map((error) => `  - ${error}`),
    "  示例：feat(git-gate): 按推送范围选择强相关测试",
  ];
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const mode = process.argv[2];
  if (mode === "--range") {
    // CI / 手动校验一段提交：node scripts/git-gate/commit-msg.mjs --range <base>..<head>
    const range = process.argv[3];
    if (!range || !range.includes("..")) {
      console.error("[git-gate:commit-msg] 用法：--range <base>..<head>");
      process.exitCode = 2;
    } else {
      const result = spawnSync("git", ["log", "--format=%s", range], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) {
        console.error(
          `[git-gate:commit-msg] git log ${range} 失败：${(result.stderr ?? "").trim()}`,
        );
        process.exitCode = 1;
      } else {
        const subjects = (result.stdout ?? "")
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean);
        let failed = 0;
        for (const subject of subjects) {
          const validation = validateCommitMessage(subject);
          if (validation.ok) continue;
          failed += 1;
          console.error(`[git-gate:commit-msg] ${subject}`);
          for (const error of validation.errors) console.error(`  - ${error}`);
        }
        if (failed > 0) {
          console.error(
            `[git-gate:commit-msg] ${failed}/${subjects.length} 条提交信息未通过；` +
              "允许 type：feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert|security。",
          );
          process.exitCode = 1;
        } else {
          console.log(`[git-gate:commit-msg] ${subjects.length} 条提交信息通过。`);
        }
      }
    }
  } else {
    const messagePath = mode;
    if (!messagePath) {
      console.error("[git-gate:commit-msg] 缺少提交信息文件路径（Git 会作为 $1 传入）。");
      process.exitCode = 1;
    } else {
      const result = validateCommitMessage(readFileSync(messagePath, "utf8"));
      for (const line of formatValidationErrors(result)) console.error(line);
      process.exitCode = result.ok ? 0 : 1;
    }
  }
}
