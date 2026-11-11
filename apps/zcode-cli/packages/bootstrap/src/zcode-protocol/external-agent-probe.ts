// 外部 agent 的本地探测：装没装、什么版本、有哪些模型。
//
// 这是绑定对话框的"事实来源"。对话框本身不跑进程——它只读这里给出的结果，
// 这样 UI 侧没有 spawn 权限，也避免每次打开对话框都探测一遍。
//
// 三条探测各自的失败语义（都不抛错，UI 需要的是"能不能用"而不是异常）：
// - 版本探测失败 = 未安装/不可执行 → installed: false；
// - 模型探测失败 = 空清单 → 对话框退回自由输入，不把"猜不到"呈现成"没有模型"。
//
// 探测的**编排**（哪个 CLI 跑哪条命令、按什么顺序、怎么解析）已下沉到
// shared/node 的 probeExternalPresets：desktop host 的设置页探测（S6）与这里共用
// 同一份知识，本文件只剩 ExecutionPort → runCommand 的翻译和会话扫描类探测。
import type { ExecutionPort } from "@zcode/contracts";
import {
  cwdToCommandCodeProjectDirName,
  cwdToProjectDirName,
  cwdToQoderProjectDirName,
  parseClaudeFamilyTranscript,
  parseCommandCodeTranscript,
  parseOpencodeSessionExport,
  scanClaudeFamilySessionFile,
  scanCommandCodeSessionFile,
  type ExternalAgentBinding,
  type ExternalAgentPresetStatus,
  type ExternalAgentSessionSummary,
  type ExternalAgentTranscriptPage,
} from "@zcode/shared";
import {
  probeExternalPresets,
  type ExternalAgentProbeCommandRunner,
} from "@zcode/shared/node";

// 模型清单解析的两个纯函数的权威实现在 shared/node；这里再导出保持既有 import 面
//（bootstrap 测试与外部调用方无需改路径）。
export { parseModelListLines, parseOpencodeModelCatalog } from "@zcode/shared/node";
export type { ExternalAgentPresetStatus } from "@zcode/shared";

/**
 * 外部会话相关的三个探测按驱动族分派。
 *
 * 缺省 `claude-family` 是刻意保留的：旧客户端/旧 Host 不带 driver 字段，
 * 必须继续走原来那条 `~/.codebuddy` 脚本路径，行为逐字不变。
 */
type ExternalAgentDriverKind = ExternalAgentBinding["driver"];

/** 探测结果的 RPC 形状（只读、无状态、超时重发安全）。 */
export interface ExternalAgentProbeResult {
  agents: ExternalAgentPresetStatus[];
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 跑一条短命令并回收输出。
 *
 * 复用 ExecutionPort 而不是自己 spawn：探测与执行走同一条进程边界，
 * 远程/容器会话里的探测因此也能落到正确的工作机上（与 Bash 工具同源）。
 *
 * `outputLimit` 按用途给：读 product.json 需要整份（实测 370KB），默认的 64KB
 * 会把 JSON 截断成片段、解析失败后静默退回静态表——"探测不到"于是被误读成
 * "这个 CLI 没有模型目录"。
 */
async function probeCommand(
  executionPort: ExecutionPort,
  file: string,
  args: string[],
  cwd: string,
  outputLimit?: { maxInlineBytes: number; maxBufferBytes: number },
): Promise<ProbeCommandResult> {
  try {
    const result = (await executionPort.run(
      {
        command: { mode: "argv", file, args },
        cwd,
        // PWD 对齐 cwd：opencode 的 session list/export/delete 按 PWD 过滤 project，
        // 继承启动链的陈旧 PWD 会让会话列表落在错误的 project 上（同 driver 的注释）。
        env: { set: { PWD: cwd } },
        timeoutMs: PROBE_TIMEOUT_MS,
        outputLimit: {
          maxInlineBytes: outputLimit?.maxInlineBytes ?? 64_000,
          maxBufferBytes: outputLimit?.maxBufferBytes ?? 64_000,
          persistOutput: "none",
          tailBytes: 8_000,
        },
      },
      {},
    )) as unknown;
    // spawn 失败时端口**不抛错**，而是回一个带 error 的结果且 exitCode 缺席。
    // 只看 exitCode 会把"命令不存在"判成成功——探测的整个意义就没了。
    if (hasExecutionError(result))
      return { ok: false, stdout: "", failure: classifyFailure(result) };
    const exitCode =
      typeof (result as { exitCode?: number }).exitCode === "number"
        ? (result as { exitCode: number }).exitCode
        : 0;
    return { ok: exitCode === 0, stdout: readStdout(result) };
  } catch (error) {
    // 抛出（执行端口未装配 / 远程通道断开）：命令本体根本没跑起来，
    // 这不是"没装"，是"问不到"。区分开才能让 UI 说"探测失败，可重试"。
    return { ok: false, stdout: "", failure: describeThrow(error) };
  }
}

/** 一条探测命令的结果：失败时带上"是不是基础设施问题"的判据。 */
interface ProbeCommandResult {
  ok: boolean;
  stdout: string;
  /**
   * 失败是基础设施层面的（端口未装配 / 通道断、起不来、超时），而不是命令自己
   * 跑完后非零退出。"命令不存在"（ENOENT）也归到这里：它同样无法区分"没装"
   * 与"PATH 没带过去"，把它断言成"未安装"正是之前那个误判的来源。
   */
  failure?: string;
}

/**
 * 端口回的执行级错误 → 判定它是不是"问不到"。
 *
 * ENOENT / spawn_error / timeout / cancelled / output_limit 一律算基础设施问题：
 * 命令自己跑完但退出码非零才是 `ok:false` 且不带 failure 的唯一情形。
 * 但这一步只在 `hasExecutionError` 已经为真时走到，所以返回字符串即可。
 */
export function classifyFailure(result: unknown): string {
  const record = (result && typeof result === "object" ? result : {}) as {
    status?: unknown;
    error?: { type?: unknown; message?: unknown; cause?: { code?: unknown } };
  };
  const message =
    typeof record.error?.message === "string" && record.error.message.trim()
      ? record.error.message.trim()
      : undefined;
  const code = typeof record.error?.cause?.code === "string" ? record.error.cause.code : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status === "spawn_error" || code === "ENOENT") {
    // 命令不存在时端口给的是 ENOENT：这条最容易被误读成"没安装"，如实标出来。
    return message ? `spawn_error (${code ?? "unknown"}): ${message}` : "spawn_error";
  }
  if (status === "timed_out" || record.error?.type === "timeout") return "timeout";
  if (status === "cancelled" || record.error?.type === "cancelled") return "cancelled";
  if (record.error?.type === "output_limit") return "output_limit";
  return message ?? status ?? "execution_error";
}

/** 端口自己抛出时的失败描述（远程通道断开、端口未装配…）。 */
function describeThrow(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "probe_threw";
}

/**
 * 端口是否回了执行级错误（spawn_error / timeout / cancelled / output_limit…）。
 *
 * 这是探测"装没装"的唯一可靠判据：命令不存在时端口不抛错，只把 error 放进结果，
 * 而 exitCode 字段是缺席的（不是非零）。
 */
function hasExecutionError(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const error = (result as { error?: unknown }).error;
  if (error !== undefined && error !== null) return true;
  const status = (result as { status?: unknown }).status;
  return status !== undefined && status !== "completed";
}

/**
 * 从端口的 run 结果里取 stdout 文本。
 *
 * 端口实测形状是 `{ stdout: { text, bytes, truncated, tail } }`（对象，不是字符串）；
 * 旧适配器可能直接给字符串。两种都收，取不到回空串——绝不把"取不到"当成失败。
 */
function readStdout(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const streams = record.streams;
  if (streams && typeof streams === "object") {
    const fromStreams = readStreamEntry((streams as Record<string, unknown>).stdout);
    if (fromStreams !== undefined) return fromStreams;
  }
  return readStreamEntry(record.stdout) ?? "";
}

/** 单路输出的兼容读取：字符串 / `{text}` / `{tail}` 三种形态。 */
function readStreamEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return undefined;
  const text = (entry as { text?: unknown }).text;
  if (typeof text === "string") return text;
  const tail = (entry as { tail?: unknown }).tail;
  return typeof tail === "string" ? tail : undefined;
}

/**
 * 探测全部**可绑定**预设（`adaptation === "full"`）。
 *
 * 编排在 shared/node（probeExternalPresets）；这里只做 ExecutionPort → runCommand
 * 的翻译：把"跑一条命令拿 stdout"的抽象请求落到会话执行端口上，远程/容器会话的
 * 探测因此落到真正执行的那台机器。
 */
export async function probeExternalAgents(options: {
  executionPort: ExecutionPort;
  cwd: string;
}): Promise<ExternalAgentProbeResult> {
  const runCommand: ExternalAgentProbeCommandRunner = async (input) =>
    probeCommand(
      options.executionPort,
      input.file,
      input.args,
      input.cwd,
      input.maxOutputBytes !== undefined
        ? { maxInlineBytes: input.maxOutputBytes, maxBufferBytes: input.maxOutputBytes }
        : undefined,
    );
  return { agents: await probeExternalPresets({ runCommand, cwd: options.cwd }) };
}

/**
 * 列出某 cwd 的外部会话（claude-family 落盘扫描）。
 *
 * 扫描必须发生在**执行机**上：远程/容器会话里 CLI 的 home 在工作机上，
 * zcode 进程读不到。做法与 probeServerModelCache 同款——`node -e` 内联脚本
 * 在目标机上枚举 `~/.codebuddy/projects/<cwd->/*.jsonl`，把每个文件的行流
 * 原样倒回 stdout（事件之间以 \x00 分隔），宿主侧再按行扫描出概要。
 *
 * 失败语义与探测一致：不抛错，返回空列表（目录不存在 / node 不可用都是
 * "没有可续接的会话"，不是故障）。
 */
export async function listExternalAgentSessions(options: {
  executionPort: ExecutionPort;
  cwd: string;
  limit?: number;
  /** 缺省 claude-family：旧调用方不带该字段时行为与以前完全一致。 */
  driver?: ExternalAgentDriverKind;
  /**
   * 会话落盘的 home 一级目录名；缺省 `.codebuddy`。由调用方按绑定的预设解析
   * （resolveExternalAgentSessionHomeDir）：qoder 的 CN CLI 落在 `~/.qoder-cn`。
   */
  sessionHomeDir?: string;
  /** projects 目录名的 slug 规则族；缺省 default（claude/codebuddy 规则）。 */
  projectDirSlug?: ExternalAgentProjectDirSlug;
}): Promise<ExternalAgentSessionSummary[]> {
  const limit = options.limit ?? 30;
  if (options.driver === "opencode-exec") {
    // opencode 的会话存在自己的数据库里，没有可扫的 JSONL 目录；只能问 CLI。
    // list 天然按当前 cwd 作用域（opencode 以 cwd 划分 project）。
    const listed = await probeCommand(
      options.executionPort,
      "opencode",
      ["session", "list", "--format", "json", "-n", "100"],
      options.cwd,
      { maxInlineBytes: 8_000_000, maxBufferBytes: 8_000_000 },
    );
    if (!listed.ok || !listed.stdout.trim()) return [];
    return parseOpencodeSessionListProbe(listed.stdout).slice(0, limit);
  }
  const read = await probeCommand(
    options.executionPort,
    "node",
    [
      "-e",
      buildExternalAgentSessionsScript(
        options.cwd,
        options.sessionHomeDir,
        options.driver,
        options.projectDirSlug,
      ),
    ],
    options.cwd,
    { maxInlineBytes: 8_000_000, maxBufferBytes: 8_000_000 },
  );
  if (!read.ok || !read.stdout.trim()) return [];
  return parseExternalAgentSessionsProbe(read.stdout, options.driver).slice(0, limit);
}

/**
 * 宿主侧解析 `opencode session list --format json` 的输出。
 *
 * 形状：`[{id, title, updated, created, projectId, directory}]`。只取列表需要的
 * 三个字段；`updated` 是 epoch ms，按它降序（新到旧）再截前 30 条——菜单只展示
 * 最近的一批，全量塞进下拉框既慢也没用。
 * 解析失败返回空数组：列表是尽力而为的展示，畸形输出不该让整个菜单报错。
 */
export function parseOpencodeSessionListProbe(stdout: string): ExternalAgentSessionSummary[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const summaries: ExternalAgentSessionSummary[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as { id?: unknown; title?: unknown; updated?: unknown };
    if (typeof record.id !== "string" || !record.id) continue;
    summaries.push({
      sessionId: record.id,
      // 没标题的会话用 id 占位（与 claude-family 的"标题缺席退 id"同口径）。
      title:
        typeof record.title === "string" && record.title.trim() ? record.title.trim() : record.id,
      updatedAt: typeof record.updated === "number" ? record.updated : 0,
    });
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 30);
}

/**
 * 探测脚本源码。
 *
 * 分隔符必须用 `String.fromCharCode(0)` 现算，**不能**把 `\u0000` 写进脚本字面量：
 * argv 里的字面量 NUL 会让 spawn 直接抛 `ERR_INVALID_ARG_VALUE`（Windows 上尤其
 * 明显，因为命令行是单字符串），整条探测静默返回空列表——会话列表永远是空的。
 * 输出流里用 NUL 分隔仍然安全（JSONL 正文不会出现裸 NUL）。
 */
export function buildExternalAgentSessionsScript(
  cwd: string,
  sessionHomeDir?: string,
  driver?: ExternalAgentDriverKind,
  projectDirSlug?: ExternalAgentProjectDirSlug,
): string {
  const projectDirName = resolveExternalAgentProjectDirName(cwd, driver, projectDirSlug);
  return [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    `const dir=path.join(os.homedir(),${JSON.stringify(sessionHomeDir ?? ".codebuddy")},'projects',${JSON.stringify(projectDirName)});`,
    "let files=[];",
    // 只收 transcript：Command Code 的 checkpoints/prompts 也是 .jsonl 侧车，
    // 不过滤会把它们当成两个"会话"混进续接列表（CLI 自己的扫描也排除这三类）。
    "try{files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')&&!f.includes('.checkpoints.')&&!f.includes('.prompts.')&&!f.includes('.v2.bak'));}catch{process.exit(0);}",
    "const stats=files.map(f=>{try{return {f,m:fs.statSync(path.join(dir,f)).mtimeMs};}catch{return null;}}).filter(Boolean);",
    "stats.sort((a,b)=>b.m-a.m);",
    "const NUL=String.fromCharCode(0);",
    "for(const {f,m} of stats.slice(0,60)){",
    "  let content='';",
    "  try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch{continue;}",
    "  process.stdout.write(NUL+'FILE'+NUL+f+NUL+m+NUL+content.split(NUL).join('')+NUL+'END'+NUL);",
    "}",
  ].join("");
}

/** 宿主侧解析探测输出（与 `buildExternalAgentSessionsScript` 的线格式配对）。 */
export function parseExternalAgentSessionsProbe(
  stdout: string,
  driver?: ExternalAgentDriverKind,
): ExternalAgentSessionSummary[] {
  const scan =
    driver === "commandcode-exec" ? scanCommandCodeSessionFile : scanClaudeFamilySessionFile;
  const summaries: ExternalAgentSessionSummary[] = [];
  for (const block of stdout.split("\u0000END\u0000")) {
    const parts = block.split("\u0000FILE\u0000");
    if (parts.length < 2) continue;
    const rest = parts[1]!.split("\u0000");
    const fileName = rest[0] ?? "";
    const mtimeMs = Number(rest[1] ?? 0);
    const content = rest.slice(2).join("\u0000");
    if (!fileName || !content) continue;
    const summary = scan(
      content,
      fileName.slice(0, -".jsonl".length),
      Number.isFinite(mtimeMs) ? mtimeMs : 0,
    );
    if (summary) summaries.push(summary);
  }
  return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
}

// ── 外部会话的删除与完整上下文 ──
//
// 两条都必须在**执行机**上做（远程会话的 CLI home 在远端），与列表扫描同源：
// 用 `node -e` 内联脚本操作同一个 projects 目录。

/** projects 目录名的 slug 规则族（预设 projectDirSlug）。 */
export type ExternalAgentProjectDirSlug = "default" | "qoder";

/**
 * 解析 projects 目录名。三个 CLI 族各有 slug 规则：
 * - commandcode：slugify（小写、音标折叠）；
 * - qoder（国际版与 CN 版）：`C:\x` → `C--x`（盘符保留大小写、冒号也折叠）；
 * - 其余（claude/codebuddy）：`C:\x` → `c-x`（盘符小写、冒号丢弃）。
 * 用错规则只会指向不存在的目录，列表静默为空。
 */
function resolveExternalAgentProjectDirName(
  cwd: string,
  driver?: ExternalAgentDriverKind,
  projectDirSlug?: ExternalAgentProjectDirSlug,
): string {
  if (projectDirSlug === "qoder") return cwdToQoderProjectDirName(cwd);
  if (driver === "commandcode-exec") return cwdToCommandCodeProjectDirName(cwd);
  return cwdToProjectDirName(cwd);
}

/** 会话 id 会被拼进执行机上的路径：只允许文件名安全字符（uuid/hex 足够）。 */
const SAFE_EXTERNAL_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 单次读取的会话文件上限；超过只取尾部（最近的上下文才是用户要看的）。
 *
 * 4MB 是权衡：整份内容要作为一条 RPC 响应走回宿主（协议单帧 1MB、逻辑帧可拼），
 * 再大的文件读起来慢且没有额外价值——分页本身只取一页，尾部足够翻很多页。
 */
const TRANSCRIPT_READ_LIMIT_BYTES = 4_000_000;

/**
 * 删除脚本：删 `<id>.jsonl` 和同名的附属目录（CLI 用它存工具产物/文件历史）。
 *
 * 返回 `1` = 确实删掉了东西，`0` = 本来就不存在（幂等语义）。
 */
export function buildDeleteExternalAgentSessionScript(
  cwd: string,
  externalSessionId: string,
  sessionHomeDir?: string,
  driver?: ExternalAgentDriverKind,
  projectDirSlug?: ExternalAgentProjectDirSlug,
): string {
  const home = sessionHomeDir ?? ".codebuddy";
  const projectDirName = resolveExternalAgentProjectDirName(cwd, driver, projectDirSlug);
  // Command Code 的会话由 transcript + 多个侧车文件组成；只删 .jsonl 会让
  // meta/checkpoint 等残留。file-history 在 home 下的独立目录，也一并清理。
  const sidecars =
    driver === "commandcode-exec"
      ? [
          ".meta.json",
          ".share.json",
          ".checkpoints.jsonl",
          ".prompts.jsonl",
          ".scheduled-tasks.json",
          ".v2.bak",
        ]
      : [];
  return [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    `const dir=path.join(os.homedir(),${JSON.stringify(home)},'projects',${JSON.stringify(projectDirName)});`,
    `const id=${JSON.stringify(externalSessionId)};`,
    "const targets=[path.join(dir,id+'.jsonl'),path.join(dir,id)];",
    ...(sidecars.length > 0
      ? [`for(const suffix of ${JSON.stringify(sidecars)}) targets.push(path.join(dir,id+suffix));`]
      : []),
    ...(driver === "commandcode-exec"
      ? [`targets.push(path.join(os.homedir(),${JSON.stringify(home)},'file-history',id));`]
      : []),
    "const existed=targets.some(t=>{try{return fs.existsSync(t);}catch{return false;}});",
    "for(const t of targets){try{fs.rmSync(t,{recursive:true,force:true});}catch{}}",
    "process.stdout.write(existed?'1':'0');",
  ].join("");
}

/** 删除一个外部会话；id 不合法或脚本失败都按"没删"处理，绝不抛错。 */
export async function deleteExternalAgentSession(options: {
  executionPort: ExecutionPort;
  cwd: string;
  externalSessionId: string;
  /** 缺省 claude-family：旧调用方不带该字段时行为与以前完全一致。 */
  driver?: ExternalAgentDriverKind;
  /** 会话落盘的 home 一级目录名；缺省 `.codebuddy`（同 listExternalAgentSessions）。 */
  sessionHomeDir?: string;
  /** projects 目录名的 slug 规则族；缺省 default。 */
  projectDirSlug?: ExternalAgentProjectDirSlug;
}): Promise<boolean> {
  // id 会被拼进 argv/路径：两种驱动都先过同一道白名单。不合法直接 false，
  // 语义与"本来就不存在"一致（幂等、不抛错）。
  if (!SAFE_EXTERNAL_SESSION_ID.test(options.externalSessionId)) return false;
  if (options.driver === "opencode-exec") {
    // opencode 的删除是 CLI 子命令（连带子会话），没有 --force；退出码 0 即删除成功。
    const deleted = await probeCommand(
      options.executionPort,
      "opencode",
      ["session", "delete", options.externalSessionId],
      options.cwd,
    );
    return deleted.ok;
  }
  const read = await probeCommand(
    options.executionPort,
    "node",
    [
      "-e",
      buildDeleteExternalAgentSessionScript(
        options.cwd,
        options.externalSessionId,
        options.sessionHomeDir,
        options.driver,
        options.projectDirSlug,
      ),
    ],
    options.cwd,
  );
  return read.ok && read.stdout.trim() === "1";
}

/**
 * 读取脚本：整份文件倒回 stdout；超过上限时取尾部。
 *
 * 首行是 `1`/`0`（源文件是否被截断），其后是原始 JSONL——不套 JSON 信封，
 * 避免大文件的转义开销。
 */
export function buildExternalAgentTranscriptScript(
  cwd: string,
  externalSessionId: string,
  sessionHomeDir?: string,
  driver?: ExternalAgentDriverKind,
  projectDirSlug?: ExternalAgentProjectDirSlug,
): string {
  const projectDirName = resolveExternalAgentProjectDirName(cwd, driver, projectDirSlug);
  return [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    `const dir=path.join(os.homedir(),${JSON.stringify(sessionHomeDir ?? ".codebuddy")},'projects',${JSON.stringify(projectDirName)});`,
    `const file=path.join(dir,${JSON.stringify(externalSessionId)}+'.jsonl');`,
    `const MAX=${TRANSCRIPT_READ_LIMIT_BYTES};`,
    "let content='',truncated=false;",
    "try{",
    "  const st=fs.statSync(file);",
    "  if(st.size>MAX){",
    "    const fd=fs.openSync(file,'r');",
    "    const buf=Buffer.alloc(MAX);",
    "    fs.readSync(fd,buf,0,MAX,st.size-MAX);",
    "    fs.closeSync(fd);",
    "    content=buf.toString('utf8');truncated=true;",
    "  }else{content=fs.readFileSync(file,'utf8');}",
    "}catch{process.exit(0);}",
    "process.stdout.write((truncated?'1':'0')+String.fromCharCode(10)+content);",
  ].join("");
}

/** 读取某个外部会话的一页上下文（缺省 = 最新一页）。 */
export async function readExternalAgentSessionTranscript(options: {
  executionPort: ExecutionPort;
  cwd: string;
  externalSessionId: string;
  before?: number;
  limit?: number;
  /** 缺省 claude-family：旧调用方不带该字段时行为与以前完全一致。 */
  driver?: ExternalAgentDriverKind;
  /** 会话落盘的 home 一级目录名；缺省 `.codebuddy`（同 listExternalAgentSessions）。 */
  sessionHomeDir?: string;
  /** projects 目录名的 slug 规则族；缺省 default。 */
  projectDirSlug?: ExternalAgentProjectDirSlug;
}): Promise<ExternalAgentTranscriptPage> {
  const empty: ExternalAgentTranscriptPage = {
    sessionId: options.externalSessionId,
    entries: [],
    total: 0,
    hasMore: false,
    truncated: false,
  };
  if (!SAFE_EXTERNAL_SESSION_ID.test(options.externalSessionId)) return empty;
  if (options.driver === "opencode-exec") {
    // 走 CLI 的 export（单个 JSON）：会话不在可读的 JSONL 文件里，只能由 CLI 导出。
    const exported = await probeCommand(
      options.executionPort,
      "opencode",
      ["session", "export", options.externalSessionId],
      options.cwd,
      { maxInlineBytes: 8_000_000, maxBufferBytes: 8_000_000 },
    );
    if (!exported.ok || !exported.stdout.trim()) return empty;
    return parseOpencodeSessionExport(exported.stdout, {
      sessionId: options.externalSessionId,
      ...(options.before !== undefined ? { before: options.before } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
  }
  const read = await probeCommand(
    options.executionPort,
    "node",
    [
      "-e",
      buildExternalAgentTranscriptScript(
        options.cwd,
        options.externalSessionId,
        options.sessionHomeDir,
        options.driver,
        options.projectDirSlug,
      ),
    ],
    options.cwd,
    {
      maxInlineBytes: TRANSCRIPT_READ_LIMIT_BYTES + 1_000_000,
      maxBufferBytes: TRANSCRIPT_READ_LIMIT_BYTES + 1_000_000,
    },
  );
  if (!read.ok || !read.stdout) return empty;
  const newline = read.stdout.indexOf("\n");
  if (newline < 0) return empty;
  const truncated = read.stdout.slice(0, newline).trim() === "1";
  const content = read.stdout.slice(newline + 1);
  const parseOptions = {
    sessionId: options.externalSessionId,
    sourceTruncated: truncated,
    ...(options.before !== undefined ? { before: options.before } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  };
  // Command Code 的落盘是 V2 条目（role/content），与 claude-family 的逐行事件不同。
  return options.driver === "commandcode-exec"
    ? parseCommandCodeTranscript(content, parseOptions)
    : parseClaudeFamilyTranscript(content, parseOptions);
}
