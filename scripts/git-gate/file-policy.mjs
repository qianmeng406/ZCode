#!/usr/bin/env node
/**
 * 文件策略与密钥初筛。
 *
 * 本地（pre-commit / pre-push）只做**高置信、零依赖**的初筛，目标是拦住
 * 「把 .env / 私钥 / 明显泄露的 token 提交进来」这类事故；权威扫描在 CI
 * 由 gitleaks 历史扫描负责。宁可漏报也不要误报，否则门禁会被绕过。
 *
 * 用法：
 *   node scripts/git-gate/file-policy.mjs --staged
 *   node scripts/git-gate/file-policy.mjs --base <sha> [--head <sha>]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeRange, readChangedFiles, readFileAtRevision } from "./changed.mjs";

const ALLOWED_ENV_FILES = /(?:\.env\.(?:example|template|sample)|\.env\.example\.[\w.-]+)$/u;
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".pdf",
  ".wasm",
  ".exe",
  ".dll",
  ".dylib",
  ".so",
  ".node",
  ".mp4",
  ".mp3",
  ".webm",
]);

const FORBIDDEN_PATHS = [
  {
    rule: "env-file",
    test: (file) =>
      /(^|\/)\.env(\.|$)/u.test(posix.basename(file)) && !ALLOWED_ENV_FILES.test(file),
    reason: "不要提交环境变量文件；如为模板请命名为 .env.example / .env.template",
  },
  {
    rule: "private-key-file",
    test: (file) => /\.(?:pem|key|p12|pfx|keystore|jks)$/iu.test(file),
    reason: "不要提交私钥或证书容器文件",
  },
  {
    rule: "ssh-private-key",
    test: (file) => /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(file),
    reason: "不要提交 SSH 私钥",
  },
  {
    rule: "vendored-dependencies",
    test: (file) => /(^|\/)node_modules\//u.test(file),
    reason: "不要提交依赖目录",
  },
  {
    rule: "release-output",
    test: (file) => /(^|\/)dist-release\//u.test(file),
    reason: "不要提交发布产物目录",
  },
];

const SECRET_PATTERNS = [
  {
    rule: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/u,
  },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
  { rule: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/u },
  { rule: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { rule: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u },
  { rule: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/u },
  { rule: "npm-auth-token", pattern: /_authToken\s*=\s*\S{8,}/u },
];

// 示例值常带这些词；真实泄露的凭据几乎不会出现它们。
const FAKE_VALUE_MARKERS = /(?:example|sample|dummy|fake|placeholder|redacted|xxxx|0000)/iu;
// 测试与 fixture 会故意存放假私钥块，内容初筛跳过这些路径；路径规则仍然生效。
// 权威扫描由 CI gitleaks 负责。
const CONTENT_SCAN_EXEMPT_RE =
  /(^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)\/|\.(?:test|spec)\.[^/]+$/iu;

export function isContentScanExempt(relPath) {
  return CONTENT_SCAN_EXEMPT_RE.test(relPath.split("\\").join("/"));
}

export function isBinaryPath(relPath) {
  return BINARY_EXTENSIONS.has(posix.extname(relPath).toLowerCase());
}

/** 路径级规则；返回命中的规则说明或 undefined。 */
export function classifyPath(relPath) {
  const file = relPath.split("\\").join("/");
  for (const entry of FORBIDDEN_PATHS) {
    if (entry.test(file)) return { rule: entry.rule, reason: entry.reason };
  }
  return undefined;
}

/** 内容级密钥初筛；返回命中列表（行号从 1 开始）。 */
export function findSecretHits(relPath, content) {
  if (isContentScanExempt(relPath)) return [];
  if (isBinaryPath(relPath) || content.includes("\0")) return [];
  const hits = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const entry of SECRET_PATTERNS) {
      if (!entry.pattern.test(line)) continue;
      if (FAKE_VALUE_MARKERS.test(line)) continue;
      hits.push({ rule: entry.rule, line: index + 1, excerpt: line.trim().slice(0, 160) });
      break;
    }
  }
  return hits;
}

/**
 * @param {{path: string, content: string}[]} files
 * @returns {{path: string, rule: string, reason: string}[]}
 */
export function evaluateFiles(files) {
  const violations = [];
  for (const file of files) {
    const pathViolation = classifyPath(file.path);
    if (pathViolation) {
      violations.push({ path: file.path, ...pathViolation });
      continue;
    }
    for (const hit of findSecretHits(file.path, file.content)) {
      violations.push({
        path: file.path,
        rule: hit.rule,
        reason: `疑似密钥（第 ${hit.line} 行）：${hit.excerpt}`,
      });
    }
  }
  return violations;
}

export function formatViolations(violations) {
  return violations.map(
    (violation) => `[git-gate:policy] ${violation.path}: ${violation.rule} — ${violation.reason}`,
  );
}

function readStagedFiles(cwd) {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`git diff --cached 失败：${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").split("\0").filter(Boolean);
}

export function collectStagedFileContents(cwd) {
  return readStagedFiles(cwd).map((path) => {
    let content = "";
    try {
      content = readFileSync(join(cwd, path), "utf8");
    } catch {
      // 已暂存但工作区被删除：按空内容处理，路径规则仍会生效。
    }
    return { path, content };
  });
}

export async function collectRevisionFileContents(cwd, range) {
  if (!range) throw new Error("无法确定比较范围；请显式传 --base <sha>。");
  const { changed } = await readChangedFiles(cwd, range);
  return changed.map((path) => ({
    path,
    content: readFileAtRevision(cwd, range.head, path) ?? "",
  }));
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  try {
    const files = args.includes("--staged")
      ? collectStagedFileContents(cwd)
      : await collectRevisionFileContents(
          cwd,
          normalizeRange({ cwd, base: option("--base"), head: option("--head") ?? "HEAD" }),
        );
    const violations = evaluateFiles(files);
    for (const line of formatViolations(violations)) console.error(line);
    if (violations.length > 0) {
      console.error(`[git-gate:policy] 共 ${violations.length} 处违规。`);
      process.exitCode = 1;
    } else {
      console.log(`[git-gate:policy] 已检查 ${files.length} 个文件，未发现禁止路径或高置信密钥。`);
    }
  } catch (error) {
    console.error(`[git-gate:policy] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
