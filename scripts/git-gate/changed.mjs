#!/usr/bin/env node
/**
 * 变更范围解析：确定「这次推送/这次 PR」要比较的 base..head，并读出增删文件。
 *
 * 复用既有约定：pre-push stdin 的 remote sha 优先，其次 upstream，再回退默认分支；
 * 显式 ZCODE_GATE_BASE（兼容旧名）优先于一切。无法确定范围时不猜、不跑全量，
 * 由调用方 fail closed 并提示显式传 base。
 */

import { spawnSync } from "node:child_process";

import { selectDefaultBranchRef } from "../affected-unit-test-baseline.mjs";
import { parsePrePushInput } from "../pre-push-gate.mjs";
import { gitFileNames } from "../architecture/git-file-names.mjs";

const ZERO_SHA = /^0{40}$/u;
const CHANGED_DIFF_FILTER = "ACMRTUXB";

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} 启动失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} 失败${detail ? `：${detail}` : ""}`);
  }
  return result.stdout.trim();
}

export function hasCommit(cwd, ref) {
  if (!ref) return false;
  return Boolean(runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true }));
}

function resolvePrePushTarget(cwd, stdin) {
  const entries = parsePrePushInput(stdin ?? "");
  if (entries.length === 0) return undefined;

  const head = runGit(cwd, ["rev-parse", "HEAD"]);
  const currentRef = runGit(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
  const candidate =
    entries.find((entry) => entry.localSha === head && !ZERO_SHA.test(entry.localSha)) ??
    entries.find((entry) => entry.localRef === currentRef && !ZERO_SHA.test(entry.localSha)) ??
    entries.find((entry) => !ZERO_SHA.test(entry.localSha));

  if (!candidate || ZERO_SHA.test(candidate.remoteSha)) return undefined;
  if (!hasCommit(cwd, candidate.remoteSha) || !hasCommit(cwd, candidate.localSha)) return undefined;

  return {
    base: candidate.remoteSha,
    head: candidate.localSha,
    label: `pre-push 远端 ${candidate.remoteRef}`,
    useMergeBase: false,
  };
}

function resolveUpstreamTarget(cwd) {
  const upstream = runGit(
    cwd,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    {
      allowFailure: true,
    },
  );
  if (!hasCommit(cwd, upstream)) return undefined;
  return { base: upstream, head: "HEAD", label: `upstream ${upstream}`, useMergeBase: false };
}

function resolveDefaultBranchTarget(cwd) {
  const originHead = runGit(
    cwd,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true },
  );
  const ref = selectDefaultBranchRef({
    originHead,
    hasCommit: (candidate) => hasCommit(cwd, candidate),
  });
  if (!ref) return undefined;
  return { base: ref, head: "HEAD", label: `默认分支 ${ref}`, useMergeBase: true };
}

/**
 * @returns {{base: string, head: string, label: string, useMergeBase: boolean} | undefined}
 */
export function resolveChangeRange({ cwd, env = process.env, stdin = "" } = {}) {
  const explicitBase =
    env.ZCODE_GATE_BASE?.trim() ||
    env.ZCODE_PRE_PUSH_BASE?.trim() ||
    env.ZCODE_AFFECTED_TEST_BASE?.trim();
  if (explicitBase) {
    if (!hasCommit(cwd, explicitBase)) {
      throw new Error(`显式 base 不存在或不是 commit：${explicitBase}`);
    }
    return {
      base: explicitBase,
      head: "HEAD",
      label: `显式 base ${explicitBase}`,
      useMergeBase: true,
    };
  }

  return (
    resolvePrePushTarget(cwd, stdin) ??
    resolveUpstreamTarget(cwd) ??
    resolveDefaultBranchTarget(cwd)
  );
}

/** 供 CI / 手动指定的范围使用。 */
export function normalizeRange({ cwd, base, head = "HEAD" }) {
  if (!base) return undefined;
  if (!hasCommit(cwd, base)) throw new Error(`base 不存在或不是 commit：${base}`);
  if (!hasCommit(cwd, head)) throw new Error(`head 不存在或不是 commit：${head}`);
  return { base, head, label: `显式 ${base}..${head}`, useMergeBase: false };
}

/** 计算实际用于 diff 的起点（默认分支需要先取 merge-base）。 */
export function resolveComparisonBase(cwd, range) {
  return range.useMergeBase ? runGit(cwd, ["merge-base", range.base, range.head]) : range.base;
}

/** @returns {Promise<{changed: string[], deleted: string[], comparisonBase: string}>} */
export async function readChangedFiles(cwd, range) {
  const comparisonBase = resolveComparisonBase(cwd, range);
  const [changed, deleted] = await Promise.all([
    gitFileNames(cwd, [
      "diff",
      "--name-only",
      "-z",
      `--diff-filter=${CHANGED_DIFF_FILTER}`,
      comparisonBase,
      range.head,
    ]),
    gitFileNames(cwd, ["diff", "--name-only", "-z", "--diff-filter=D", comparisonBase, range.head]),
  ]);
  return { changed, deleted, comparisonBase };
}

/** 读取某个 commit 下的文件内容；文件不存在时返回 undefined。 */
export function readFileAtRevision(cwd, revision, relPath) {
  const result = spawnSync("git", ["show", `${revision}:${relPath}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

/** 整个范围的增删行统计：path → { added, deleted }。 */
export function diffNumstatMap(cwd, comparisonBase, head) {
  const output =
    runGit(cwd, ["diff", "--numstat", comparisonBase, head], { allowFailure: true }) ?? "";
  const stats = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    stats.set(path, {
      added: Number.isFinite(Number(added)) ? Number(added) : 0,
      deleted: Number.isFinite(Number(deleted)) ? Number(deleted) : 0,
    });
  }
  return stats;
}

/** 某个文件在 base..head 的增删行数（用于判断 barrel 是否删除了导出）。 */
export function diffLineStats(cwd, comparisonBase, head, relPath) {
  const output = runGit(cwd, ["diff", "--numstat", comparisonBase, head, "--", relPath], {
    allowFailure: true,
  });
  const [added, deleted] = (output ?? "").split("\t");
  return {
    added: Number.isFinite(Number(added)) ? Number(added) : 0,
    deleted: Number.isFinite(Number(deleted)) ? Number(deleted) : 0,
  };
}
